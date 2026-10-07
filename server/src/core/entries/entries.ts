import type { Enclosure, Entry, EntryState, Stream } from '@rss-reader/shared';
import { and, eq, inArray, ne, or, type SQL, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { enclosures, userEntries } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';
import type { Realtime } from '../ports.ts';
import { streamCondition } from './streams.ts';
import { excerpt } from './text.ts';

/** Search ranks the most recent matches only, so common terms stay fast on large instances. */
export const SEARCH_CANDIDATES = 1000;
/** Searches matching at most this many entries instance-wide are resolved from the GIN index. */
const SELECTIVE_MATCHES = 20_000;
/** Pages with content end early past this many content characters, keeping responses small. */
const PAGE_CONTENT_CHARS = 2_000_000;

export type ListOrder = 'newest' | 'oldest' | 'title' | 'relevance';

export interface ListOptions {
  stream: Stream;
  view: 'all' | 'unread' | 'adaptive';
  order?: ListOrder | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit: number;
  content: boolean;
}

export interface ListResult {
  entries: Entry[];
  cursor: string | null;
  view: 'all' | 'unread';
}

const cursorSchema = z.union([
  z.object({ v: z.enum(['all', 'unread']), k: z.string(), i: z.number().int() }),
  z.object({ v: z.enum(['all', 'unread']), o: z.number().int().min(0) }),
]);
type Cursor = z.infer<typeof cursorSchema>;

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new DomainError('invalid_input', 'Invalid cursor');
  }
}

/** ISO-8601 UTC text of a timestamptz expression. */
export const iso = (expr: SQL) =>
  sql`to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface HeadlineRow extends Record<string, unknown> {
  id: string;
  entry_id: string;
  subscription_id: number | null;
  feed_title: string | null;
  title: string | null;
  link: string | null;
  author: string | null;
  published_at: string | null;
  sort_at: string;
  unread: boolean;
  starred: boolean;
  published: boolean;
  note: string | null;
  labels: number[];
  tags: string[];
  share_id: string | null;
  head: string | null;
  content?: string | null;
  /** Keyset sort key as text. */
  k?: string;
}

/** Headline columns of `user_entries ue` joined as in `HEADLINE_FROM`. */
export const headlineColumns = (withContent: boolean) => sql`
  ue.id, ue.entry_id, ue.subscription_id, coalesce(s.title, fs.title, fs.url) AS feed_title,
  e.title, e.link, e.author, ${iso(sql`e.published_at`)} AS published_at,
  ${iso(sql`ue.sort_at`)} AS sort_at, ue.unread, ue.starred, ue.published, ue.note, ue.share_id,
  array(SELECT el.label_id FROM entry_labels el WHERE el.user_entry_id = ue.id ORDER BY 1) AS labels,
  array(SELECT et.tag FROM entry_tags et WHERE et.user_entry_id = ue.id ORDER BY 1) AS tags,
  left(e.content, 4000) AS head${withContent ? sql`, e.content` : sql``}`;

export const HEADLINE_FROM = sql`user_entries ue
  JOIN entries e ON e.id = ue.entry_id
  JOIN feed_sources fs ON fs.id = e.feed_source_id
  LEFT JOIN subscriptions s ON s.id = ue.subscription_id`;

export function toEntry(row: HeadlineRow): Entry {
  return {
    id: Number(row.id),
    subscriptionId: row.subscription_id,
    feedTitle: row.feed_title,
    title: row.title,
    link: row.link,
    author: row.author,
    publishedAt: row.published_at,
    sortAt: row.sort_at,
    unread: row.unread,
    starred: row.starred,
    published: row.published,
    note: row.note,
    labels: row.labels,
    tags: row.tags,
    shareId: row.share_id,
    excerpt: excerpt(row.head),
    ...(row.content !== undefined && { content: row.content }),
  };
}

/** The user's note on `ue` matches `query`; served by the partial index on notes. */
const noteMatches = (query: SQL) =>
  sql`(ue.note IS NOT NULL AND to_tsvector('simple', ue.note) @@ ${query})`;

/** Entry text or the user's note matches `query`. */
const matches = (query: SQL) => sql`(e.search @@ ${query} OR ${noteMatches(query)})`;

interface OrderSpec {
  /** Sort key expression; also returned as `k` for the cursor. */
  key: SQL;
  keyType: SQL;
  direction: 'ASC' | 'DESC';
}

function orderSpec(order: Exclude<ListOrder, 'relevance'>, stream: Stream): OrderSpec {
  if (order === 'title')
    return { key: sql`lower(coalesce(e.title, ''))`, keyType: sql`text`, direction: 'ASC' };
  // Recently read lists in reading order.
  const time = stream.special === 'recentlyRead' ? sql`ue.read_at` : sql`ue.sort_at`;
  return { key: time, keyType: sql`timestamptz`, direction: order === 'oldest' ? 'ASC' : 'DESC' };
}

export class EntryService {
  readonly #db: Db;
  readonly #realtime: Realtime;
  readonly #selectiveMatches: number;
  readonly #pageContentChars: number;

  constructor(
    db: Db,
    realtime: Realtime,
    options: { selectiveMatches?: number; pageContentChars?: number } = {},
  ) {
    this.#db = db;
    this.#realtime = realtime;
    this.#selectiveMatches = options.selectiveMatches ?? SELECTIVE_MATCHES;
    this.#pageContentChars = options.pageContentChars ?? PAGE_CONTENT_CHARS;
  }

  /**
   * One page of headlines in `stream`, keyset-paginated; full-text search of entry text and the
   * user's notes when `q` is given.
   *
   * Search plans by selectivity, because the planner's estimates for text queries are unreliable:
   * a query matching few entries instance-wide is resolved from the GIN indexes into a materialised
   * set that is then sorted; a common one walks the headline index, where matches are dense. Notes
   * are few, so they do not count towards selectivity.
   */
  async list(userId: number, options: ListOptions): Promise<ListResult> {
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const order = options.order ?? (options.q ? 'relevance' : 'newest');
    if (order === 'relevance' && !options.q)
      throw new DomainError('invalid_input', 'Relevance order requires a search query');
    const stream = streamCondition(userId, options.stream);
    const view = cursor?.v ?? (await this.#resolveView(stream, options.view));
    const where = sql`${stream}${view === 'unread' ? sql` AND ue.unread` : sql``}`;
    const query = options.q ? sql`websearch_to_tsquery('simple', ${options.q})` : null;
    const selective = query !== null && (await this.#isSelective(query));
    const spec = orderSpec(order === 'relevance' ? 'newest' : order, options.stream);
    // The user's matches (by entry text or note), for selective searches. Materialised, so no
    // plan can walk an index hoping to meet matches; sorting by its columns rather than table
    // columns keeps it that way.
    const hits =
      query && selective
        ? sql`WITH matched AS MATERIALIZED (
              SELECT ue.id FROM entries e JOIN user_entries ue ON ue.entry_id = e.id
              WHERE e.search @@ ${query} AND ue.user_id = ${userId}
              UNION
              SELECT ue.id FROM user_entries ue WHERE ue.user_id = ${userId} AND ${noteMatches(query)}),
            hits AS MATERIALIZED (
              SELECT ue.id, ue.sort_at AS t, ${spec.key} AS k
              FROM matched m JOIN user_entries ue ON ue.id = m.id JOIN entries e ON e.id = ue.entry_id
              WHERE ${where})`
        : null;

    let rows: HeadlineRow[];
    const offset = cursor && 'o' in cursor ? cursor.o : 0;
    if (order === 'relevance' && query) {
      const candidates = hits
        ? sql`${hits}, candidates AS (SELECT id FROM hits ORDER BY t DESC LIMIT ${SEARCH_CANDIDATES})`
        : sql`WITH candidates AS (
            SELECT ue.id FROM user_entries ue JOIN entries e ON e.id = ue.entry_id
            WHERE ${where} AND ${matches(query)}
            ORDER BY ue.sort_at DESC NULLS LAST LIMIT ${SEARCH_CANDIDATES})`;
      const result = await this.#db.execute<HeadlineRow>(sql`
        ${candidates}
        SELECT ${headlineColumns(options.content)}
        FROM candidates c JOIN ${HEADLINE_FROM} ON ue.id = c.id
        ORDER BY ts_rank(e.search, ${query})
          + ts_rank(to_tsvector('simple', coalesce(ue.note, '')), ${query}) DESC, ue.id DESC
        OFFSET ${offset} LIMIT ${options.limit + 1}`);
      rows = result.rows;
    } else {
      const key = hits ? sql`h.k` : spec.key;
      const id = hits ? sql`h.id` : sql`ue.id`;
      const comparison = spec.direction === 'DESC' ? sql`<` : sql`>`;
      const after =
        cursor && 'k' in cursor
          ? sql` AND (${key}, ${id}) ${comparison} (${cursor.k}::${spec.keyType}, ${cursor.i})`
          : sql``;
      const filter = hits ? sql`TRUE` : query ? sql`${where} AND ${matches(query)}` : where;
      // Matches the indexes' `DESC NULLS LAST` (forward) or its backward scan; keys are never null.
      const direction = sql.raw(spec.direction === 'DESC' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST');
      const result = await this.#db.execute<HeadlineRow>(sql`
        ${hits ?? sql``}
        SELECT ${headlineColumns(options.content)}, ${key}::text AS k
        FROM ${hits ? sql`hits h JOIN ${HEADLINE_FROM} ON ue.id = h.id` : HEADLINE_FROM}
        WHERE ${filter}${after}
        ORDER BY ${key} ${direction}, ${id} ${direction}
        LIMIT ${options.limit + 1}`);
      rows = result.rows;
    }

    const size = options.content ? this.#fitContent(rows, options.limit) : options.limit;
    const page = rows.slice(0, size);
    const last = page.at(-1);
    let next: Cursor | null = null;
    if (rows.length > size && last) {
      if (order === 'relevance') next = { v: view, o: offset + size };
      else if (last.k != null) next = { v: view, k: last.k, i: Number(last.id) };
    }
    const entries = page.map(toEntry);
    if (options.content) await this.#attachEnclosures(page, entries);
    return { entries, cursor: next && encodeCursor(next), view };
  }

  /** How many of `rows` (at most `limit`, at least one) fit the page's content budget. */
  #fitContent(rows: HeadlineRow[], limit: number): number {
    let chars = 0;
    for (const [i, row] of rows.slice(0, limit).entries()) {
      chars += row.content?.length ?? 0;
      if (chars > this.#pageContentChars && i > 0) return i;
    }
    return limit;
  }

  /** Whether `query` matches few enough entries instance-wide to resolve from the GIN index. */
  async #isSelective(query: SQL): Promise<boolean> {
    const result = await this.#db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM entries e WHERE e.search @@ ${query} LIMIT ${this.#selectiveMatches + 1}) x`);
    return (result.rows[0]?.n ?? 0) <= this.#selectiveMatches;
  }

  /** One entry with content and enclosures. */
  async get(userId: number, id: number): Promise<Entry> {
    const result = await this.#db.execute<HeadlineRow>(sql`
      SELECT ${headlineColumns(true)} FROM ${HEADLINE_FROM}
      WHERE ue.user_id = ${userId} AND ue.id = ${id}`);
    const row = result.rows[0];
    if (!row) throw new DomainError('not_found', 'Entry not found');
    const entry = toEntry(row);
    await this.#attachEnclosures([row], [entry]);
    return entry;
  }

  /** Sets flags on the user's entries; rows already in that state are left untouched. */
  async setState(userId: number, ids: number[], state: EntryState): Promise<number> {
    const set: PgUpdateSetSource<typeof userEntries> = {};
    const differs: SQL[] = [];
    if (state.unread !== undefined) {
      set.unread = state.unread;
      set.readAt = state.unread ? null : sql`now()`;
      differs.push(ne(userEntries.unread, state.unread));
    }
    if (state.starred !== undefined) {
      set.starred = state.starred;
      differs.push(ne(userEntries.starred, state.starred));
    }
    if (state.published !== undefined) {
      set.published = state.published;
      differs.push(ne(userEntries.published, state.published));
    }
    if (differs.length === 0 || ids.length === 0) return 0;
    const updated = await this.#db
      .update(userEntries)
      .set(set)
      .where(and(eq(userEntries.userId, userId), inArray(userEntries.id, ids), or(...differs)))
      .returning({ id: userEntries.id });
    if (updated.length > 0) await this.#realtime.publish(userId, { type: 'counters' });
    return updated.length;
  }

  /** Sets or, with null or blank text, clears the user's note on an entry. */
  async setNote(userId: number, id: number, note: string | null): Promise<void> {
    const text = note?.trim() || null;
    const updated = await this.#db
      .update(userEntries)
      .set({ note: text })
      .where(and(eq(userEntries.userId, userId), eq(userEntries.id, id)))
      .returning({ id: userEntries.id });
    if (updated.length === 0) throw new DomainError('not_found', 'Entry not found');
  }

  /** Shares one of the user's entries at a public link; returns its id, existing or new. */
  async share(userId: number, id: number): Promise<string> {
    const result = await this.#db.execute<{ share_id: string }>(sql`
      UPDATE user_entries SET share_id = coalesce(share_id, gen_random_uuid())
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING share_id`);
    const row = result.rows[0];
    if (!row) throw new DomainError('not_found', 'Entry not found');
    return row.share_id;
  }

  /** Revokes the entry's share link. */
  async unshare(userId: number, id: number): Promise<void> {
    const updated = await this.#db
      .update(userEntries)
      .set({ shareId: null })
      .where(and(eq(userEntries.userId, userId), eq(userEntries.id, id)))
      .returning({ id: userEntries.id });
    if (updated.length === 0) throw new DomainError('not_found', 'Entry not found');
  }

  /** The user's shared entries, newest first. */
  async listShared(userId: number): Promise<Entry[]> {
    const result = await this.#db.execute<HeadlineRow>(sql`
      SELECT ${headlineColumns(false)} FROM ${HEADLINE_FROM}
      WHERE ue.user_id = ${userId} AND ue.share_id IS NOT NULL
      ORDER BY ue.sort_at DESC, ue.id DESC`);
    return result.rows.map(toEntry);
  }

  /** An entry shared at `shareId`, with content, unless its owner is disabled. */
  async getShared(shareId: string): Promise<{ userId: number; entry: Entry } | null> {
    const result = await this.#db.execute<HeadlineRow & { user_id: number }>(sql`
      SELECT ${headlineColumns(true)}, ue.user_id FROM ${HEADLINE_FROM}
      JOIN users u ON u.id = ue.user_id
      WHERE ue.share_id = ${shareId} AND u.disabled_at IS NULL`);
    const row = result.rows[0];
    if (!row) return null;
    const entry = toEntry(row);
    await this.#attachEnclosures([row], [entry]);
    return { userId: row.user_id, entry };
  }

  /** The user's most recently published entries, with content, for their public feed. */
  async listPublished(userId: number, limit: number): Promise<Entry[]> {
    const result = await this.#db.execute<HeadlineRow>(sql`
      SELECT ${headlineColumns(true)} FROM ${HEADLINE_FROM}
      WHERE ue.user_id = ${userId} AND ue.published
      ORDER BY ue.sort_at DESC NULLS LAST, ue.id DESC NULLS LAST
      LIMIT ${limit}`);
    const entries = result.rows.map(toEntry);
    await this.#attachEnclosures(result.rows, entries);
    return entries;
  }

  /**
   * Catch-up: marks unread entries in `stream` read, optionally only those older than
   * `olderThanDays` or with an id up to `maxId`.
   */
  async markRead(
    userId: number,
    stream: Stream,
    options: { olderThanDays?: number | undefined; maxId?: number | undefined } = {},
  ): Promise<number> {
    const older =
      options.olderThanDays === undefined
        ? sql``
        : sql` AND ue.sort_at < now() - make_interval(days => ${options.olderThanDays})`;
    const upTo = options.maxId === undefined ? sql`` : sql` AND ue.id <= ${options.maxId}`;
    const result = await this.#db.execute(sql`
      UPDATE user_entries ue SET unread = false, read_at = now()
      WHERE ${streamCondition(userId, stream)} AND ue.unread${older}${upTo}`);
    const updated = result.rowCount ?? 0;
    if (updated > 0) await this.#realtime.publish(userId, { type: 'counters' });
    return updated;
  }

  async #resolveView(stream: SQL, view: ListOptions['view']): Promise<'all' | 'unread'> {
    if (view !== 'adaptive') return view;
    const result = await this.#db.execute(
      sql`SELECT 1 FROM user_entries ue WHERE ${stream} AND ue.unread LIMIT 1`,
    );
    return result.rows.length > 0 ? 'unread' : 'all';
  }

  async #attachEnclosures(rows: HeadlineRow[], entries: Entry[]): Promise<void> {
    if (rows.length === 0) return;
    const found = await this.#db
      .select()
      .from(enclosures)
      .where(
        inArray(
          enclosures.entryId,
          rows.map((r) => Number(r.entry_id)),
        ),
      );
    const byEntry = new Map<number, Enclosure[]>();
    for (const { entryId, url, mimeType, length, width, height, durationSeconds } of found) {
      const list = byEntry.get(entryId) ?? [];
      list.push({ url, mimeType, length, width, height, durationSeconds });
      byEntry.set(entryId, list);
    }
    rows.forEach((row, index) => {
      const entry = entries[index];
      if (entry) entry.enclosures = byEntry.get(Number(row.entry_id)) ?? [];
    });
  }
}
