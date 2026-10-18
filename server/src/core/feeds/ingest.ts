import { createHash } from 'node:crypto';
import { normaliseTags } from '@newses/shared';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { enclosures, entries } from '../../db/schema.ts';
import type { FeedSettings } from '../config.ts';
import type { Realtime } from '../ports.ts';
import { runFilters } from '../filters/run.ts';
import { userPrefInt } from '../prefs.ts';
import type { ParsedEntry } from './parse.ts';
import { sanitizeContent, sanitizeTitle, stripControlChars } from './sanitize.ts';

export interface IngestResult {
  inserted: number;
  updated: number;
}

/** At most this many entries are taken from one document, newest first by position. */
const MAX_ENTRIES_PER_FETCH = 500;

/**
 * GUID prefix of entries imported from TTRSS, whose own GUIDs are not the feed's. The first
 * fetched item with the same link takes such an entry over instead of duplicating it.
 */
export const IMPORTED_GUID_PREFIX = 'ttrss:';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface PreparedEntry {
  guid: string;
  link: string | null;
  title: string | null;
  author: string | null;
  content: string | null;
  contentHash: string;
  publishedAt: Date | null;
  sourceUpdatedAt: Date | null;
  categories: string[];
  enclosures: ParsedEntry['enclosures'];
}

function prepare(entry: ParsedEntry, siteUrl: string | null): PreparedEntry | null {
  const title = sanitizeTitle(entry.title);
  const content = entry.content
    ? sanitizeContent(entry.content, entry.link ?? siteUrl) || null
    : null;
  const link = entry.link ? stripControlChars(entry.link) : null;
  // Entries without a GUID are identified by link and title, else by content.
  const identity = entry.guid ?? (link || title ? `${link ?? ''}\n${title ?? ''}` : content);
  if (!identity) return null;
  return {
    guid: entry.guid ? stripControlChars(entry.guid).slice(0, 2000) : `sha256:${sha256(identity)}`,
    link,
    title,
    author: entry.author ? sanitizeTitle(entry.author) : null,
    content,
    contentHash: sha256(`${title ?? ''}\n${link ?? ''}\n${content ?? ''}`),
    publishedAt: entry.publishedAt,
    sourceUpdatedAt: entry.updatedAt,
    categories: normaliseTags(entry.categories),
    enclosures: entry.enclosures,
  };
}

/**
 * Gives new items the imported entries with the same link, so the upsert updates those entries
 * rather than adding duplicates. Of several imported entries with one link, the newest is taken.
 */
async function adoptImported(
  tx: Pick<Db, 'execute'>,
  feedSourceId: number,
  fresh: PreparedEntry[],
): Promise<void> {
  const byLink = new Map<string, string>();
  for (const entry of fresh)
    if (entry.link && !byLink.has(entry.link)) byLink.set(entry.link, entry.guid);
  if (byLink.size === 0) return;
  await tx.execute(sql`
    UPDATE entries e SET guid = n.guid, last_seen_at = now()
    FROM unnest(${sql.param([...byLink.keys()])}::text[], ${sql.param([...byLink.values()])}::text[]) AS n(link, guid)
    WHERE e.id = (
      SELECT max(i.id) FROM entries i
      WHERE i.feed_source_id = ${feedSourceId} AND i.link = n.link
        AND i.guid LIKE ${`${IMPORTED_GUID_PREFIX}%`})`);
}

/** Purge age of subscription `s`: its override, else its user's preference, else the default. */
export const purgeDaysSql = (defaultDays: number): SQL<number> =>
  sql`coalesce(s.purge_days, ${userPurgeDaysSql(sql`s.user_id`, defaultDays)})`;

/** A user's purge age: their `purgeDays` preference, else the instance default; 0 never. */
export const userPurgeDaysSql = (userId: SQL, defaultDays: number): SQL<number> =>
  sql`coalesce(${userPrefInt(userId, 'purgeDays')}, ${defaultDays})`;

/** Stores parsed entries and hands new ones to every subscriber of the feed source. */
export class Ingester {
  readonly #db: Db;
  readonly #realtime: Realtime;
  readonly #settings: FeedSettings;

  constructor(db: Db, realtime: Realtime, settings: FeedSettings) {
    this.#db = db;
    this.#realtime = realtime;
    this.#settings = settings;
  }

  async ingest(
    feedSourceId: number,
    siteUrl: string | null,
    parsed: ParsedEntry[],
  ): Promise<IngestResult> {
    const byGuid = new Map<string, PreparedEntry>();
    for (const entry of parsed.slice(0, MAX_ENTRIES_PER_FETCH)) {
      const prepared = prepare(entry, siteUrl);
      if (prepared && !byGuid.has(prepared.guid)) byGuid.set(prepared.guid, prepared);
    }
    const prepared = [...byGuid.values()];
    if (prepared.length === 0) return { inserted: 0, updated: 0 };

    const result = await this.#db.transaction(async (tx) => {
      const seen = await tx
        .update(entries)
        .set({ lastSeenAt: sql`now()` })
        .where(
          and(eq(entries.feedSourceId, feedSourceId), inArray(entries.guid, [...byGuid.keys()])),
        )
        .returning({ guid: entries.guid });
      const known = new Set(seen.map((row) => row.guid));
      await adoptImported(
        tx,
        feedSourceId,
        prepared.filter((entry) => !known.has(entry.guid) && entry.link),
      );

      // Inserts new entries; rewrites existing ones only when their content changed.
      const written = await tx
        .insert(entries)
        .values(prepared.map(({ enclosures, ...entry }) => ({ ...entry, feedSourceId })))
        .onConflictDoUpdate({
          target: [entries.feedSourceId, entries.guid],
          set: {
            link: sql`excluded.link`,
            title: sql`excluded.title`,
            author: sql`excluded.author`,
            content: sql`excluded.content`,
            contentHash: sql`excluded.content_hash`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
            categories: sql`excluded.categories`,
          },
          setWhere: sql`${entries.contentHash} <> excluded.content_hash`,
        })
        .returning({ id: entries.id, guid: entries.guid, inserted: sql<boolean>`xmax = 0` });

      const changedIds = written.map((row) => row.id);
      if (changedIds.length > 0) {
        await tx.delete(enclosures).where(inArray(enclosures.entryId, changedIds));
        const enclosureRows = written.flatMap((row) =>
          (byGuid.get(row.guid)?.enclosures ?? []).map((e) => ({
            entryId: row.id,
            url: e.url.slice(0, 4000),
            mimeType: e.mimeType,
            length: e.length,
            width: e.width,
            height: e.height,
            durationSeconds: e.durationSeconds === null ? null : Math.round(e.durationSeconds),
          })),
        );
        if (enclosureRows.length > 0)
          await tx.insert(enclosures).values(enclosureRows).onConflictDoNothing();
      }

      const newIds = written.filter((row) => row.inserted).map((row) => row.id);
      const users = newIds.length > 0 ? await this.#deliver(tx, inArray(sql`e.id`, newIds)) : [];
      return { inserted: newIds.length, updated: written.length - newIds.length, users };
    });

    await this.#notify(result.users);
    return { inserted: result.inserted, updated: result.updated };
  }

  /** Gives a new subscription the feed's existing entries within its purge window. */
  async backfill(subscriptionId: number): Promise<void> {
    const users = await this.#db.transaction((tx) =>
      this.#deliver(tx, sql`s.id = ${subscriptionId}`),
    );
    await this.#notify(users);
  }

  /** Fans out, then runs each recipient's filters over what they received. */
  async #deliver(executor: Pick<Db, 'execute'>, condition: SQL): Promise<number[]> {
    const delivered = await this.#fanOut(executor, condition);
    await runFilters(executor, delivered);
    return [...new Set(delivered.map((d) => d.userId))];
  }

  /**
   * Creates unread user entries for matching entries and subscriptions, skipping entries already
   * older than the subscription's purge age, and tags them with the entries' feed categories.
   * Returns the user entries created.
   */
  async #fanOut(
    executor: Pick<Db, 'execute'>,
    condition: SQL,
  ): Promise<{ id: number; userId: number }[]> {
    const rows = await executor.execute<{ id: string; user_id: number }>(sql`
      WITH delivered AS (
        INSERT INTO user_entries (user_id, entry_id, subscription_id, sort_at)
        SELECT s.user_id, e.id, s.id, LEAST(coalesce(e.published_at, e.fetched_at), now())
        FROM entries e
        JOIN subscriptions s ON s.feed_source_id = e.feed_source_id
        CROSS JOIN LATERAL (SELECT ${purgeDaysSql(this.#settings.purgeDays)} AS days) purge
        WHERE ${condition}
          AND (
            purge.days = 0
            OR LEAST(coalesce(e.published_at, e.fetched_at), now()) > now() - make_interval(days => purge.days)
          )
        ON CONFLICT (user_id, entry_id) DO NOTHING
        RETURNING id, user_id, entry_id
      ), tagged AS (
        INSERT INTO entry_tags (user_entry_id, user_id, tag)
        SELECT d.id, d.user_id, tag
        FROM delivered d JOIN entries e ON e.id = d.entry_id CROSS JOIN unnest(e.categories) AS tag
        ON CONFLICT DO NOTHING
      )
      SELECT id, user_id FROM delivered`);
    return rows.rows.map((row) => ({ id: Number(row.id), userId: row.user_id }));
  }

  async #notify(userIds: number[]): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.#realtime.publish(userId, { type: 'counters' })),
    );
  }
}
