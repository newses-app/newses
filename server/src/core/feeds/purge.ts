import { type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { FeedSettings } from '../config.ts';
import { iso } from '../entries/entries.ts';
import { plainText } from '../entries/text.ts';
import type { ArchivedEnclosure, ArchiveRow, ArchiveWriter, BlobStore } from '../ports.ts';
import { deleteUnusedIcons } from './favicons.ts';
import { purgeDaysSql, userPurgeDaysSql } from './ingest.ts';
import { PAGES_SOURCE_URL } from './pages.ts';

/** Unreferenced entries are deleted only after they have been absent from their feed this long. */
const ORPHAN_GRACE_DAYS = 7;

/** Entries archived and deleted per batch; content makes rows large. */
const ARCHIVE_BATCH = 1000;

/** How long one purge may spend archiving; the rest waits for the next run. */
const ARCHIVE_BUDGET_MS = 3 * 60 * 1000;

/** User entries (`ue`) that purge and unsubscribe never delete. */
export const KEPT_ENTRY = sql`(ue.starred OR ue.published OR ue.note IS NOT NULL
  OR ue.share_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM entry_labels el WHERE el.user_entry_id = ue.id))`;

/**
 * Ids of entries some user keeps, as KEPT_ENTRY says, in a form the kept-entry indexes serve; a
 * parenthesised subquery.
 */
export const KEPT_ENTRY_IDS = sql`(SELECT ue.entry_id FROM user_entries ue
  WHERE ue.starred OR ue.published OR ue.note IS NOT NULL OR ue.share_id IS NOT NULL
  UNION SELECT ue.entry_id FROM entry_labels el JOIN user_entries ue ON ue.id = el.user_entry_id)`;

const UNREFERENCED = sql`NOT EXISTS (SELECT 1 FROM user_entries ue WHERE ue.entry_id = e.id)`;

/** Entries (`e`) nobody references that have been absent from their feed for the grace period. */
const ORPHAN = sql`e.last_seen_at < now() - make_interval(days => ${ORPHAN_GRACE_DAYS}) AND ${UNREFERENCED}`;

/** Entries (`e`) of the pages source: one user's own, so never archived. */
const PAGE = sql`e.feed_source_id IN (SELECT id FROM feed_sources WHERE url = ${PAGES_SOURCE_URL})`;

/** Feed sources (`fs`) with no subscribers and no entries anyone holds; never the pages source. */
const ABANDONED_SOURCE = sql`fs.url <> ${PAGES_SOURCE_URL}
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_source_id = fs.id)
  AND NOT EXISTS (
    SELECT 1 FROM entries e JOIN user_entries ue ON ue.entry_id = e.id WHERE e.feed_source_id = fs.id
  )`;

export interface PurgeResult {
  userEntries: number;
  entries: number;
  feedSources: number;
  /** Entries written to the archive before they were deleted. */
  archived: number;
}

export interface PurgeOptions {
  /** Archives entries before deleting them; null deletes them outright. */
  archive?: ArchiveWriter | null;
  /** Time one purge may spend archiving. */
  archiveBudgetMs?: number;
  now?: () => number;
}

interface ArchiveSourceRow extends Record<string, unknown> {
  id: string;
  feed_url: string;
  feed_title: string | null;
  guid: string;
  link: string | null;
  title: string | null;
  author: string | null;
  content: string | null;
  lang: string | null;
  published_at: string | null;
  source_updated_at: string | null;
  fetched_at: string;
  sort_at: string;
  enclosures: {
    url: string;
    mime_type: string | null;
    length: number | null;
    width: number | null;
    height: number | null;
    duration_seconds: number | null;
  }[];
}

export class Purger {
  readonly #db: Db;
  readonly #blobs: BlobStore;
  readonly #settings: FeedSettings;
  readonly #archive: ArchiveWriter | null;
  readonly #archiveBudgetMs: number;
  readonly #now: () => number;

  constructor(db: Db, blobs: BlobStore, settings: FeedSettings, options: PurgeOptions = {}) {
    this.#db = db;
    this.#blobs = blobs;
    this.#settings = settings;
    this.#archive = options.archive ?? null;
    this.#archiveBudgetMs = options.archiveBudgetMs ?? ARCHIVE_BUDGET_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Deletes user entries older than their subscription's purge age, and those outside any feed
   * (pages, entries of unsubscribed feeds) unchanged for the user's purge age, so counted from
   * when they stopped being kept; never kept ones. Then
   * entries nobody references that have left their feed, then feed sources with no subscribers
   * and no kept entries. With an archive, entries are written to it before they are deleted,
   * except pages, which only their user could read. Also forgets expired host cooldowns.
   */
  async purge(): Promise<PurgeResult> {
    const userEntries = await this.#db.execute(sql`
      DELETE FROM user_entries ue
      USING subscriptions s CROSS JOIN LATERAL (SELECT ${purgeDaysSql(this.#settings.purgeDays)} AS days) purge
      WHERE ue.subscription_id = s.id
        AND NOT ${KEPT_ENTRY}
        AND purge.days > 0
        AND ue.sort_at < now() - make_interval(days => purge.days)`);
    const unsubscribed = await this.#db.execute(sql`
      DELETE FROM user_entries ue
      USING users u CROSS JOIN LATERAL (SELECT ${userPurgeDaysSql(sql`u.id`, this.#settings.purgeDays)} AS days) purge
      WHERE ue.user_id = u.id AND ue.subscription_id IS NULL
        AND NOT ${KEPT_ENTRY}
        AND purge.days > 0
        AND ue.updated_at < now() - make_interval(days => purge.days)`);

    const pages = await this.#db.execute(sql`DELETE FROM entries e WHERE ${ORPHAN} AND ${PAGE}`);
    const deadline = this.#now() + this.#archiveBudgetMs;
    const orphans = await this.#deleteEntries(sql`${ORPHAN} AND NOT ${PAGE}`, deadline);
    // Deleting a source deletes its entries, so with an archive they go first, and a source
    // goes only once none are left.
    let sourceEntries = { deleted: 0, archived: 0 };
    if (this.#archive)
      sourceEntries = await this.#deleteEntries(
        sql`${UNREFERENCED} AND e.feed_source_id IN (SELECT fs.id FROM feed_sources fs WHERE ${ABANDONED_SOURCE})`,
        deadline,
      );
    const sources = await this.#db.execute<{ id: number; favicon_key: string | null }>(sql`
      DELETE FROM feed_sources fs
      WHERE ${ABANDONED_SOURCE}
        ${this.#archive ? sql`AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.feed_source_id = fs.id)` : sql``}
      RETURNING fs.id, fs.favicon_key`);
    // Other sources of the same site may still show their icons.
    await deleteUnusedIcons(
      this.#db,
      this.#blobs,
      sources.rows.map((row) => row.favicon_key),
    );
    await this.#db.execute(sql`
      DELETE FROM fetch_hosts
      WHERE coalesce(blocked_until, '-infinity') < now() AND coalesce(leased_until, '-infinity') < now()`);

    return {
      userEntries: (userEntries.rowCount ?? 0) + (unsubscribed.rowCount ?? 0),
      entries: (pages.rowCount ?? 0) + orphans.deleted + sourceEntries.deleted,
      feedSources: sources.rows.length,
      archived: orphans.archived + sourceEntries.archived,
    };
  }

  /**
   * Deletes entries (`e`) matching `condition`. With an archive, writes each batch to it first,
   * until the deadline; the delete checks `condition` again, so an entry that came back into use
   * meanwhile stays (and is also in the archive, where readers prefer the database's copy).
   */
  async #deleteEntries(
    condition: SQL,
    deadline: number,
  ): Promise<{ deleted: number; archived: number }> {
    const archive = this.#archive;
    if (!archive) {
      const result = await this.#db.execute(sql`DELETE FROM entries e WHERE ${condition}`);
      return { deleted: result.rowCount ?? 0, archived: 0 };
    }
    let deleted = 0;
    let archived = 0;
    let after = '0';
    while (this.#now() < deadline) {
      const batch = await this.#db.execute<ArchiveSourceRow>(sql`
        SELECT e.id, fs.url AS feed_url, fs.title AS feed_title, e.guid, e.link, e.title, e.author,
          e.content, e.lang, ${iso(sql`e.published_at`)} AS published_at,
          ${iso(sql`e.source_updated_at`)} AS source_updated_at, ${iso(sql`e.fetched_at`)} AS fetched_at,
          ${iso(sql`LEAST(coalesce(e.published_at, e.fetched_at), e.fetched_at)`)} AS sort_at,
          coalesce((
            SELECT json_agg(json_build_object('url', x.url, 'mime_type', x.mime_type,
              'length', x.length, 'width', x.width, 'height', x.height,
              'duration_seconds', x.duration_seconds) ORDER BY x.id)
            FROM enclosures x WHERE x.entry_id = e.id), '[]') AS enclosures
        FROM entries e JOIN feed_sources fs ON fs.id = e.feed_source_id
        WHERE ${condition} AND e.id > ${after}
        ORDER BY e.id
        LIMIT ${ARCHIVE_BATCH}`);
      const last = batch.rows.at(-1);
      if (!last) break;
      const archivedAt = new Date(this.#now());
      await archive.write(batch.rows.map((row) => archiveRow(row, archivedAt)));
      archived += batch.rows.length;
      const ids = batch.rows.map((row) => row.id);
      const result = await this.#db.execute(sql`
        DELETE FROM entries e WHERE e.id = ANY(${sql.param(ids)}::bigint[]) AND ${condition}`);
      deleted += result.rowCount ?? 0;
      after = last.id;
      if (batch.rows.length < ARCHIVE_BATCH) break;
    }
    return { deleted, archived };
  }
}

function archiveRow(row: ArchiveSourceRow, archivedAt: Date): ArchiveRow {
  return {
    id: Number(row.id),
    feedUrl: row.feed_url,
    feedTitle: row.feed_title,
    guid: row.guid,
    link: row.link,
    title: row.title,
    author: row.author,
    content: row.content,
    text: plainText(row.content),
    lang: row.lang,
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
    sourceUpdatedAt: row.source_updated_at === null ? null : new Date(row.source_updated_at),
    fetchedAt: new Date(row.fetched_at),
    sortAt: new Date(row.sort_at),
    archivedAt,
    enclosures: row.enclosures.map((x): ArchivedEnclosure => ({
      url: x.url,
      mimeType: x.mime_type,
      length: x.length,
      width: x.width,
      height: x.height,
      durationSeconds: x.duration_seconds,
    })),
  };
}
