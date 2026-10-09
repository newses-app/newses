import { MAX_SCORE } from '@rss-reader/shared';
import { sql } from 'drizzle-orm';
import { DomainError } from '../../core/errors.ts';
import { IMPORTED_GUID_PREFIX, purgeDaysSql, sha256 } from '../../core/feeds/ingest.ts';
import { sanitizeContent, sanitizeTitle, stripControlChars } from '../../core/feeds/sanitize.ts';
import { normalizeFeedUrl } from '../../core/feeds/url.ts';
import { enclosures, entries, userEntries } from '../../db/schema.ts';
import type { ImportContext, ImportStep } from '../importer.ts';
import type { Writer } from '../import-map.ts';
import { type ImportedUser, importedUsers } from './common.ts';
import { FEEDS } from './feeds.ts';

export const USER_ENTRIES = 'ttrss_user_entries';
/** User entries read and written per batch; content makes rows large. */
const BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SourceEntryRow {
  id: number;
  ref_id: number;
  feed_id: number | null;
  orig_feed_id: number | null;
  unread: boolean;
  marked: boolean;
  published: boolean;
  last_read: Date | null;
  score: number;
  /** Has a note, a share link, or a label: kept like starred and published entries. */
  marked_otherwise: boolean;
  title: string;
  link: string;
  content: string;
  author: string;
  lang: string | null;
  updated: Date;
  date_entered: Date;
  date_updated: Date;
}

interface SourceEnclosureRow {
  post_id: number;
  content_url: string;
  content_type: string;
  duration: string;
  width: number;
  height: number;
}

// TTRSS stores times without a zone, in UTC.
const ENTRY_QUERY = (after: string, limit: string) => `
  SELECT ue.int_id AS id, ue.ref_id, ue.feed_id, ue.orig_feed_id, ue.unread, ue.marked,
    ue.published, ue.score, ue.last_read AT TIME ZONE 'UTC' AS last_read,
    (coalesce(ue.note, '') <> '' OR ue.uuid <> '' OR EXISTS (
      SELECT 1 FROM ttrss_user_labels2 ul JOIN ttrss_labels2 l ON l.id = ul.label_id
      WHERE ul.article_id = ue.ref_id AND l.owner_uid = ue.owner_uid)) AS marked_otherwise,
    e.title, e.link, e.content, e.author, e.lang,
    e.updated AT TIME ZONE 'UTC' AS updated, e.date_entered AT TIME ZONE 'UTC' AS date_entered,
    e.date_updated AT TIME ZONE 'UTC' AS date_updated
  FROM ttrss_user_entries ue JOIN ttrss_entries e ON e.id = ue.ref_id
  WHERE ue.owner_uid = $1 AND ue.int_id > ${after}
  ORDER BY ue.int_id LIMIT ${limit}`;

const clampScore = (score: number) => Math.max(-MAX_SCORE, Math.min(MAX_SCORE, score));

/** Seconds from a TTRSS duration: plain seconds or `[h:]m:s`. */
export function durationSeconds(text: string): number | null {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value));
  if (!/^\d+(:\d{1,2}){1,2}$/.test(value)) return null;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** Counts of entries skipped for one reason, reported together. */
class Skips {
  readonly #counts = new Map<string, number>();

  add(reason: string): void {
    this.#counts.set(reason, (this.#counts.get(reason) ?? 0) + 1);
  }

  report({ report }: ImportContext, login: string): void {
    for (const [reason, count] of this.#counts) report.skip(login, 'entries', 0, reason, count);
  }
}

/** The user's subscriptions here: their feed source and purge age (0 never purges). */
async function subscriptionsOf(context: ImportContext, userId: number) {
  const result = await context.db.execute<{ id: number; feed_source_id: number; days: number }>(sql`
    SELECT s.id, s.feed_source_id, ${purgeDaysSql(context.purgeDays)} AS days
    FROM subscriptions s WHERE s.user_id = ${userId}`);
  return new Map(result.rows.map((row) => [row.id, row]));
}

/** Feed sources for the user's archived feeds (unsubscribed feeds that kept entries), by id. */
async function archivedSources(context: ImportContext, user: ImportedUser) {
  const { source, report, write } = context;
  const rows = await source.query<{
    id: number;
    feed_url: string;
    title: string;
    site_url: string;
  }>(
    'SELECT id, feed_url, title, site_url FROM ttrss_archived_feeds WHERE owner_uid = $1 ORDER BY id',
    [user.source.id],
  );
  report.count(user.source.login, 'archived feeds', { source: rows.length });
  const sources = new Map<number, number>();
  for (const row of rows) {
    report.skip(
      user.source.login,
      'archived feeds',
      row.id,
      'archived feeds are not imported; their entries are kept without a feed',
    );
    let url: string;
    try {
      url = normalizeFeedUrl(row.feed_url);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      continue;
    }
    const id = await write(async (tx) => {
      const result = await tx.execute<{ id: number }>(sql`
        INSERT INTO feed_sources (url, title, site_url) VALUES (${url}, ${row.title}, ${row.site_url || null})
        ON CONFLICT (url) DO UPDATE SET title = coalesce(feed_sources.title, excluded.title)
        RETURNING id`);
      return result.rows[0]?.id;
    });
    if (id !== undefined) sources.set(row.id, id);
  }
  return sources;
}

interface Prepared {
  row: SourceEntryRow;
  feedSourceId: number;
  subscriptionId: number | null;
  sortAt: Date;
  /** The shared entry, sanitised as ingest stores fetched items. */
  entry: typeof entries.$inferInsert & { guid: string };
}

/** Writes one batch: shared entries (deduplicated), enclosures, the user's entries, the map. */
async function writeBatch(
  context: ImportContext,
  tx: Writer,
  userId: number,
  batch: Prepared[],
  enclosureRows: SourceEnclosureRow[],
) {
  const values = new Map<string, Prepared['entry']>();
  for (const { feedSourceId, entry } of batch)
    values.set(`${String(feedSourceId)} ${entry.guid}`, entry);
  const written = await tx
    .insert(entries)
    .values([...values.values()])
    .onConflictDoUpdate({
      target: [entries.feedSourceId, entries.guid],
      set: { guid: sql`excluded.guid` },
    })
    .returning({ id: entries.id, feedSourceId: entries.feedSourceId, guid: entries.guid });
  const entryIds = new Map(written.map((e) => [`${String(e.feedSourceId)} ${e.guid}`, e.id]));
  const entryOf = (p: Prepared) => entryIds.get(`${String(p.feedSourceId)} ${p.entry.guid}`) ?? 0;

  const byRef = new Map(batch.map((p) => [p.row.ref_id, entryOf(p)]));
  const files = enclosureRows.flatMap((e) => {
    const entryId = byRef.get(e.post_id);
    return entryId && e.content_url
      ? [
          {
            entryId,
            url: e.content_url.slice(0, 4000),
            mimeType: e.content_type || null,
            width: e.width || null,
            height: e.height || null,
            durationSeconds: durationSeconds(e.duration),
          },
        ]
      : [];
  });
  if (files.length > 0) await tx.insert(enclosures).values(files).onConflictDoNothing();

  // Two TTRSS rows of one user that became one entry merge: read if either was, kept if either was.
  const states = new Map<number, typeof userEntries.$inferInsert>();
  for (const p of batch) {
    const entryId = entryOf(p);
    const { row } = p;
    const current = states.get(entryId);
    const unread = row.unread && (current?.unread ?? true);
    states.set(entryId, {
      userId,
      entryId,
      subscriptionId: current?.subscriptionId ?? p.subscriptionId,
      sortAt: p.sortAt,
      unread,
      starred: row.marked || (current?.starred ?? false),
      published: row.published || (current?.published ?? false),
      // Merged copies keep the score furthest from zero.
      score: [clampScore(row.score), current?.score ?? 0].reduce((a, b) =>
        Math.abs(b) > Math.abs(a) ? b : a,
      ),
      readAt: unread ? null : (row.last_read ?? current?.readAt ?? row.date_entered),
    });
  }
  const delivered = await tx
    .insert(userEntries)
    .values([...states.values()])
    .onConflictDoUpdate({
      target: [userEntries.userId, userEntries.entryId],
      set: {
        subscriptionId: sql`excluded.subscription_id`,
        sortAt: sql`excluded.sort_at`,
        unread: sql`excluded.unread`,
        starred: sql`excluded.starred`,
        published: sql`excluded.published`,
        score: sql`excluded.score`,
        readAt: sql`excluded.read_at`,
      },
    })
    .returning({ id: userEntries.id, entryId: userEntries.entryId });
  const userEntryIds = new Map(delivered.map((d) => [d.entryId, d.id]));
  await context.map.record(
    tx,
    USER_ENTRIES,
    batch.map((p) => ({ sourceId: p.row.id, targetId: userEntryIds.get(entryOf(p)) ?? 0, userId })),
  );
}

/**
 * Entries and article state. TTRSS keeps a copy of an article per user; copies with the same
 * feed source, title, link, and content become one shared entry, with a `ttrss:` GUID that the
 * first fetched item with its link takes over. Entries purge would delete at once, and with
 * `--since` older ones, are skipped unless kept (starred, published, noted, labelled, shared).
 */
export const entriesStep: ImportStep = {
  name: 'entries',
  async run(context) {
    const { source, map, report, write, options } = context;
    for (const user of await importedUsers(context)) {
      const { login } = user.source;
      const userId = user.userId;
      const [subs, archived] = await Promise.all([
        subscriptionsOf(context, userId),
        archivedSources(context, user),
      ]);
      const skips = new Skips();
      const now = Date.now();
      for await (const rows of source.batches<SourceEntryRow>(
        ENTRY_QUERY,
        [user.source.id],
        BATCH,
      )) {
        report.count(login, 'entries', { source: rows.length });
        const feedIds = [...new Set(rows.flatMap((r) => (r.feed_id === null ? [] : [r.feed_id])))];
        const feedSubs = await map.targets(FEEDS, feedIds);
        const batch: Prepared[] = [];
        for (const row of rows) {
          let subscriptionId: number | null = null;
          let feedSourceId: number | undefined;
          if (row.feed_id !== null) {
            subscriptionId = feedSubs.get(row.feed_id) ?? null;
            feedSourceId =
              subscriptionId === null ? undefined : subs.get(subscriptionId)?.feed_source_id;
            if (feedSourceId === undefined) {
              skips.add('its feed was not imported');
              continue;
            }
          } else {
            feedSourceId = row.orig_feed_id === null ? undefined : archived.get(row.orig_feed_id);
            if (feedSourceId === undefined) {
              skips.add('it belongs to no feed');
              continue;
            }
          }
          const sortAt = new Date(Math.min(row.updated.getTime(), now));
          const kept = row.marked || row.published || row.marked_otherwise;
          if (!kept && options.since && sortAt < options.since) {
            skips.add('older than --since');
            continue;
          }
          const days = subscriptionId === null ? 0 : (subs.get(subscriptionId)?.days ?? 0);
          if (!kept && days > 0 && sortAt.getTime() < now - days * DAY_MS) {
            skips.add('older than its purge age');
            continue;
          }
          const title = sanitizeTitle(row.title);
          const link = row.link ? stripControlChars(row.link) : null;
          const content = row.content ? sanitizeContent(row.content, link) || null : null;
          // The same recipe as ingest's content hash; as the GUID, it merges identical copies.
          const contentHash = sha256(`${title ?? ''}\n${link ?? ''}\n${content ?? ''}`);
          batch.push({
            row,
            feedSourceId,
            subscriptionId,
            sortAt,
            entry: {
              feedSourceId,
              guid: `${IMPORTED_GUID_PREFIX}${contentHash}`,
              link,
              title,
              author: row.author ? sanitizeTitle(row.author) : null,
              content,
              contentHash,
              lang: row.lang || null,
              publishedAt: row.updated,
              sourceUpdatedAt: row.date_updated,
              fetchedAt: row.date_entered,
            },
          });
        }
        if (batch.length === 0) continue;
        const enclosureRows = await source.query<SourceEnclosureRow>(
          `SELECT post_id, content_url, content_type, duration, width, height
           FROM ttrss_enclosures WHERE post_id = ANY($1) ORDER BY id`,
          [batch.map((p) => p.row.ref_id)],
        );
        await write((tx) => writeBatch(context, tx, userId, batch, enclosureRows));
        report.count(login, 'entries', { imported: batch.length });
      }
      skips.report(context, login);
    }
  },
};
