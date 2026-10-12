import type { ArchivedEntry, Enclosure, Entry, EntryState } from '@newses/shared';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { DomainError } from '../errors.ts';
import { sha256 } from '../feeds/ingest.ts';
import type { ArchivePosition, ArchiveReader, ArchiveRow } from '../ports.ts';
import { type EntryService, iso } from './entries.ts';
import { excerpt } from './text.ts';

/** Search uses at most this many words. */
const MAX_TERMS = 10;
/** Archive pages read per request while the database's copies fill them. */
const COLD_ROUNDS = 5;

interface Feed {
  subscriptionId: number;
  feedSourceId: number;
  url: string;
  title: string;
}

interface Item extends ArchivePosition {
  entry: ArchivedEntry;
}

export interface ArchiveListOptions {
  subscriptionId?: number | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

const cursorSchema = z.object({ s: z.number(), f: z.string(), g: z.string() });

function encodeCursor(p: ArchivePosition): string {
  const cursor = { s: p.sortAt.getTime(), f: p.feedUrl, g: p.guid };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string): ArchivePosition {
  try {
    const c = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return { sortAt: new Date(c.s), feedUrl: c.f, guid: c.g };
  } catch {
    throw new DomainError('invalid_input', 'Invalid cursor');
  }
}

/** An article's key: the month of its sort time, then its feed URL and GUID. */
export function archiveKey(p: ArchivePosition): string {
  const id = Buffer.from(`${p.feedUrl}\n${p.guid}`).toString('base64url');
  return `${p.sortAt.toISOString().slice(0, 7)}.${id}`;
}

function parseKey(key: string): { month: string; feedUrl: string; guid: string } {
  const match = /^(\d{4}-\d{2})\.([\w-]+)$/.exec(key);
  const [feedUrl, guid] = match?.[2]
    ? Buffer.from(match[2], 'base64url')
        .toString()
        .split(/\n(.*)/s)
    : [];
  if (!match?.[1] || !feedUrl || guid === undefined)
    throw new DomainError('not_found', 'Archived entry not found');
  return { month: match[1], feedUrl, guid };
}

/** The archive's order: newest first, then feed URL and GUID, descending. */
function compare(a: ArchivePosition, b: ArchivePosition): number {
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    b.sortAt.getTime() - a.sortAt.getTime() || order(b.feedUrl, a.feedUrl) || order(b.guid, a.guid)
  );
}

const terms = (q: string | undefined) =>
  [...new Set((q ?? '').toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);

interface HotRow extends Record<string, unknown> {
  id: string;
  subscription_id: number;
  feed_url: string;
  feed_title: string;
  guid: string;
  title: string | null;
  link: string | null;
  author: string | null;
  published_at: string | null;
  sort_ms: string;
  head: string | null;
  content?: string | null;
}

/** Sort time of an entry (`e`), as fan-out sets it, in epoch milliseconds. */
const SORT_MS = sql`floor(extract(epoch FROM LEAST(coalesce(e.published_at, e.fetched_at), e.fetched_at)) * 1000)::bigint`;

/**
 * Past articles of the user's feeds: entries of their subscriptions' sources they do not hold
 * (purged for them, or older than they subscribed), and the cold-storage archive. The database's
 * copy of an article wins over the archive's. Restoring one brings it back into the user's feed.
 */
export class ArchiveService {
  readonly #db: Db;
  readonly #entries: EntryService;
  readonly #reader: ArchiveReader | null;

  constructor(db: Db, entries: EntryService, reader: ArchiveReader | null) {
    this.#db = db;
    this.#entries = entries;
    this.#reader = reader;
  }

  async list(
    userId: number,
    options: ArchiveListOptions,
  ): Promise<{ entries: ArchivedEntry[]; cursor: string | null }> {
    const { subscriptionId } = options;
    const feeds = await this.#feeds(
      userId,
      subscriptionId === undefined ? sql`true` : sql`s.id = ${subscriptionId}`,
    );
    if (subscriptionId !== undefined && feeds.length === 0)
      throw new DomainError('not_found', 'Subscription not found');
    if (feeds.length === 0) return { entries: [], cursor: null };
    const after = options.cursor ? decodeCursor(options.cursor) : null;
    const want = options.limit + 1;
    const hot = await this.#hot(userId, feeds, options.q, after, want);
    const cold = await this.#cold(feeds, terms(options.q), after, want);
    let merged = [...hot, ...cold.items].sort(compare);
    // Archive rows past the last one read were not compared, so nothing after it can be listed.
    const until = cold.more ? cold.position : null;
    if (until) merged = merged.filter((item) => compare(item, until) <= 0);
    const page = merged.slice(0, options.limit);
    const last = page.at(-1) ?? until;
    const more = merged.length > options.limit || until !== null;
    return { entries: page.map((i) => i.entry), cursor: more && last ? encodeCursor(last) : null };
  }

  /** One article with its content and enclosures. */
  async get(userId: number, key: string): Promise<ArchivedEntry> {
    const { month, feedUrl, guid } = parseKey(key);
    const feed = await this.#feed(userId, feedUrl);
    const [hot] = await this.#hotRows(
      sql`SELECT e.id, ${feed.subscriptionId}::int AS subscription_id, ${feed.url} AS feed_url,
          ${feed.title} AS feed_title, e.guid, e.title, e.link, e.author,
          ${iso(sql`e.published_at`)} AS published_at, ${SORT_MS} AS sort_ms,
          left(e.content, 4000) AS head, e.content
        FROM entries e WHERE e.feed_source_id = ${feed.feedSourceId} AND e.guid = ${guid}`,
    );
    if (hot) {
      // `length` is a bigint, which arrives as text.
      type Row = Omit<Enclosure, 'length'> & { length: string | null } & Record<string, unknown>;
      const found = await this.#db.execute<Row>(sql`
        SELECT url, mime_type AS "mimeType", length, width, height,
          duration_seconds AS "durationSeconds"
        FROM enclosures WHERE entry_id = ${hot.id} ORDER BY id`);
      const enclosures = found.rows.map((e) => ({
        ...e,
        length: e.length === null ? null : Number(e.length),
      }));
      return { ...hotItem(hot).entry, content: hot.content ?? null, enclosures };
    }
    const row = await this.#reader?.get(month, feedUrl, guid);
    if (!row) throw new DomainError('not_found', 'Archived entry not found');
    const { entry } = coldItem(row, feed);
    return { ...entry, content: row.content, enclosures: row.enclosures };
  }

  /**
   * Brings an article back into the user's feed: the entry (with its original id when free) and
   * enclosures from the archive unless the database still has it, then the user's entry, read,
   * with `state` applied. Returns the entry.
   */
  async restore(userId: number, key: string, state: EntryState): Promise<Entry> {
    const { month, feedUrl, guid } = parseKey(key);
    const feed = await this.#feed(userId, feedUrl);
    let entryId = await this.#entryId(feed, guid);
    if (entryId === null) {
      const row = await this.#reader?.get(month, feedUrl, guid);
      if (!row) throw new DomainError('not_found', 'Archived entry not found');
      entryId = await this.#insert(feed, row);
    }
    const delivered = await this.#db.execute<{ id: string }>(sql`
      WITH added AS (
        INSERT INTO user_entries (user_id, entry_id, subscription_id, sort_at, unread, read_at)
        SELECT ${userId}, e.id, ${feed.subscriptionId},
          LEAST(coalesce(e.published_at, e.fetched_at), e.fetched_at), false, now()
        FROM entries e WHERE e.id = ${entryId}
        ON CONFLICT (user_id, entry_id) DO NOTHING
        RETURNING id)
      SELECT id FROM added
      UNION ALL SELECT id FROM user_entries WHERE user_id = ${userId} AND entry_id = ${entryId}`);
    const id = Number(delivered.rows[0]?.id);
    await this.#entries.setState(userId, [id], state);
    return this.#entries.get(userId, id);
  }

  /** Merges finished months of the archive for up to `budgetMs`; returns how many. */
  async compact(budgetMs: number): Promise<number> {
    return (await this.#reader?.compact(Date.now() + budgetMs)) ?? 0;
  }

  async #feeds(userId: number, condition: SQL): Promise<Feed[]> {
    const result = await this.#db.execute<{
      id: number;
      feed_source_id: number;
      url: string;
      title: string;
    }>(sql`
      SELECT s.id, s.feed_source_id, fs.url, coalesce(s.title, fs.title, fs.url) AS title
      FROM subscriptions s JOIN feed_sources fs ON fs.id = s.feed_source_id
      WHERE s.user_id = ${userId} AND ${condition}`);
    return result.rows.map((r) => ({
      subscriptionId: r.id,
      feedSourceId: r.feed_source_id,
      url: r.url,
      title: r.title,
    }));
  }

  /** The user's subscription to the feed; only subscribers reach its archive. */
  async #feed(userId: number, feedUrl: string): Promise<Feed> {
    const [feed] = await this.#feeds(userId, sql`fs.url = ${feedUrl}`);
    if (!feed) throw new DomainError('not_found', 'Archived entry not found');
    return feed;
  }

  async #hotRows(query: SQL): Promise<HotRow[]> {
    return (await this.#db.execute<HotRow>(query)).rows;
  }

  /** Entries of the feeds' sources the user does not hold, in the archive's order. */
  async #hot(
    userId: number,
    feeds: Feed[],
    q: string | undefined,
    after: ArchivePosition | null,
    limit: number,
  ): Promise<Item[]> {
    const rows = await this.#hotRows(sql`
      SELECT * FROM (
        SELECT e.id, s.id AS subscription_id, fs.url AS feed_url,
          coalesce(s.title, fs.title, fs.url) AS feed_title, e.guid, e.title, e.link, e.author,
          ${iso(sql`e.published_at`)} AS published_at, ${SORT_MS} AS sort_ms,
          left(e.content, 4000) AS head
        FROM entries e
        JOIN subscriptions s ON s.feed_source_id = e.feed_source_id AND s.user_id = ${userId}
        JOIN feed_sources fs ON fs.id = e.feed_source_id
        WHERE s.id = ANY(${sql.param(feeds.map((f) => f.subscriptionId))}::int[])
          AND NOT EXISTS (
            SELECT 1 FROM user_entries ue WHERE ue.user_id = ${userId} AND ue.entry_id = e.id)
          ${q ? sql`AND e.search @@ plainto_tsquery('simple', ${q})` : sql``}
      ) x
      ${
        after
          ? sql`WHERE (x.sort_ms, x.feed_url COLLATE "C", x.guid COLLATE "C")
              < (${after.sortAt.getTime()}::bigint, ${after.feedUrl} COLLATE "C", ${after.guid} COLLATE "C")`
          : sql``
      }
      ORDER BY x.sort_ms DESC, x.feed_url COLLATE "C" DESC, x.guid COLLATE "C" DESC
      LIMIT ${limit}`);
    return rows.map(hotItem);
  }

  /**
   * Archive rows of the feeds that the database no longer has, reading pages until `want` are
   * found. `more` says the archive may hold further rows after `position`, the last one read.
   */
  async #cold(
    feeds: Feed[],
    words: string[],
    after: ArchivePosition | null,
    want: number,
  ): Promise<{ items: Item[]; more: boolean; position: ArchivePosition | null }> {
    const items: Item[] = [];
    if (!this.#reader) return { items, more: false, position: null };
    const byUrl = new Map(feeds.map((f) => [f.url, f]));
    let position = after;
    for (let round = 0; round < COLD_ROUNDS; round++) {
      const rows = await this.#reader.list({
        feedUrls: [...byUrl.keys()],
        terms: words,
        after: position,
        limit: want,
      });
      const hot = await this.#stillHot(rows);
      for (const row of rows) {
        const feed = byUrl.get(row.feedUrl);
        if (feed && !hot.has(`${row.feedUrl}\n${row.guid}`)) items.push(coldItem(row, feed));
      }
      position = rows.at(-1) ?? position;
      if (rows.length < want) return { items, more: false, position };
      if (items.length >= want) break;
    }
    return { items, more: true, position };
  }

  /** Feed URL and GUID of the rows the database still has. */
  async #stillHot(rows: ArchiveRow[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    const result = await this.#db.execute<{ url: string; guid: string }>(sql`
      SELECT fs.url, e.guid FROM entries e
      JOIN feed_sources fs ON fs.id = e.feed_source_id
      JOIN unnest(${sql.param(rows.map((r) => r.feedUrl))}::text[],
          ${sql.param(rows.map((r) => r.guid))}::text[]) AS k(url, guid)
        ON fs.url = k.url AND e.guid = k.guid`);
    return new Set(result.rows.map((r) => `${r.url}\n${r.guid}`));
  }

  async #entryId(feed: Feed, guid: string): Promise<number | null> {
    const result = await this.#db.execute<{ id: string }>(sql`
      SELECT id FROM entries WHERE feed_source_id = ${feed.feedSourceId} AND guid = ${guid}`);
    const id = result.rows[0]?.id;
    return id === undefined ? null : Number(id);
  }

  /** Inserts an archived article as an entry, keeping its original id unless that is taken. */
  async #insert(feed: Feed, row: ArchiveRow): Promise<number> {
    const contentHash = sha256(`${row.title ?? ''}\n${row.link ?? ''}\n${row.content ?? ''}`);
    const values = sql`${feed.feedSourceId}, ${row.guid}, ${row.link}, ${row.title}, ${row.author},
      ${row.content}, ${contentHash}, ${row.lang}, ${row.publishedAt?.toISOString() ?? null}::timestamptz,
      ${row.sourceUpdatedAt?.toISOString() ?? null}::timestamptz, ${row.fetchedAt.toISOString()}::timestamptz`;
    const columns = sql`feed_source_id, guid, link, title, author, content, content_hash, lang,
      published_at, source_updated_at, fetched_at`;
    return this.#db.transaction(async (tx) => {
      const withId =
        row.id === null
          ? { rows: [] }
          : await tx.execute<{ id: string }>(sql`
              INSERT INTO entries (id, ${columns}) OVERRIDING SYSTEM VALUE
              VALUES (${row.id}, ${values}) ON CONFLICT DO NOTHING RETURNING id`);
      const inserted =
        withId.rows[0] ??
        (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO entries (${columns}) VALUES (${values})
            ON CONFLICT (feed_source_id, guid) DO UPDATE SET guid = excluded.guid RETURNING id`)
        ).rows[0];
      const entryId = Number(inserted?.id);
      for (const e of row.enclosures)
        await tx.execute(sql`
          INSERT INTO enclosures (entry_id, url, mime_type, length, width, height, duration_seconds)
          VALUES (${entryId}, ${e.url}, ${e.mimeType}, ${e.length}, ${e.width}, ${e.height},
            ${e.durationSeconds})
          ON CONFLICT DO NOTHING`);
      return entryId;
    });
  }
}

function hotItem(row: HotRow): Item {
  const sortAt = new Date(Number(row.sort_ms));
  const position = { sortAt, feedUrl: row.feed_url, guid: row.guid };
  return {
    ...position,
    entry: {
      key: archiveKey(position),
      archived: true,
      subscriptionId: row.subscription_id,
      feedTitle: row.feed_title,
      title: row.title,
      link: row.link,
      author: row.author,
      publishedAt: row.published_at,
      sortAt: sortAt.toISOString(),
      excerpt: excerpt(row.head),
    },
  };
}

function coldItem(row: ArchiveRow, feed: Feed): Item {
  return {
    sortAt: row.sortAt,
    feedUrl: row.feedUrl,
    guid: row.guid,
    entry: {
      key: archiveKey(row),
      archived: true,
      subscriptionId: feed.subscriptionId,
      feedTitle: feed.title,
      title: row.title,
      link: row.link,
      author: row.author,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      sortAt: row.sortAt.toISOString(),
      excerpt: excerpt(row.text),
    },
  };
}
