import type { Enclosure, Entry, EntryState, StateConflict, Stream } from '@newses/shared';
import { and, eq, inArray, ne, or, type SQL, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { enclosures, userEntries } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';
import { PAGES_SOURCE_URL } from '../feeds/pages.ts';
import type { Realtime } from '../ports.ts';
import { shownCondition, streamCondition } from './streams.ts';
import { excerpt } from './text.ts';

/** Search ranks the most recent matches only, so common terms stay fast on large instances. */
export const SEARCH_CANDIDATES = 1000;
/** Searches matching at most this many entries instance-wide are resolved from the GIN index. */
const SELECTIVE_MATCHES = 20_000;
/**
 * Pages with content end early past this many bytes of content and full text, keeping responses
 * well under Lambda's 6 MB cap after JSON escaping.
 */
const PAGE_CONTENT_BYTES = 2_000_000;

/** UTF-8 size of an entry's content and full text. */
const contentBytes = (content?: string | null, fullContent?: string | null) =>
  Buffer.byteLength(content ?? '') + Buffer.byteLength(fullContent ?? '');

export type ListOrder = 'newest' | 'oldest' | 'title' | 'relevance';

export interface ListOptions {
  stream: Stream;
  view: 'all' | 'unread' | 'adaptive';
  order?: ListOrder | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit: number;
  content: boolean;
  /** Attach enclosures even without content. */
  enclosures?: boolean | undefined;
  /** Skips this many entries; for clients that page by offset rather than cursor. */
  offset?: number | undefined;
  /** Only entries with a larger id. */
  sinceId?: number | undefined;
  /** Only entries with these flags within the stream. */
  flags?: EntryFlags | undefined;
  /** Only entries sorted at or after this time. */
  sortedFrom?: Date | undefined;
  /** Only entries sorted before this time. */
  sortedBefore?: Date | undefined;
}

export interface EntryFlags {
  unread?: boolean | undefined;
  starred?: boolean | undefined;
}

export type IdListOptions = Pick<
  ListOptions,
  'stream' | 'cursor' | 'limit' | 'flags' | 'sortedFrom' | 'sortedBefore'
> & { order?: 'newest' | 'oldest' | undefined };

export interface EntryRef {
  id: number;
  subscriptionId: number | null;
  /** `sort_at` in microseconds since the epoch, as text. */
  sortAtUsec: string;
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
  score: number;
  note: string | null;
  labels: number[];
  tags: string[];
  share_id: string | null;
  read_at: string | null;
  content_version: string;
  head: string | null;
  content?: string | null;
  full_content?: string | null;
  /** Keyset sort key as text. */
  k?: string;
}

/**
 * An entry's (`e`) content version. Changes when the entry's title, link, or content does, or its full text is extracted again;
 * clients compare it to decide whether a stored copy of the content is current.
 */
export const CONTENT_VERSION = sql`left(e.content_hash, 16) || coalesce('.' || CASE
    WHEN e.full_content IS NOT NULL
    THEN floor(extract(epoch FROM e.full_content_at) * 1000)::bigint::text END, '')`;

/** A page's feed title is its site's host. */
const FEED_TITLE = sql`coalesce(s.title,
  CASE WHEN fs.url = ${PAGES_SOURCE_URL} THEN substring(e.link FROM '^[a-z]+://(?:[^/?#@]*@)?([^/?#:]+)') END,
  fs.title, fs.url)`;

/** Headline columns of `user_entries ue` joined as in `HEADLINE_FROM`. */
export const headlineColumns = (withContent: boolean) => sql`
  ue.id, ue.entry_id, ue.subscription_id, ${FEED_TITLE} AS feed_title,
  e.title, e.link, e.author, ${iso(sql`e.published_at`)} AS published_at,
  ${iso(sql`ue.sort_at`)} AS sort_at, ue.unread, ue.starred, ue.published, ue.score, ue.note,
  ue.share_id, ${iso(sql`ue.read_at`)} AS read_at, ${CONTENT_VERSION} AS content_version,
  array(SELECT el.label_id FROM entry_labels el WHERE el.user_entry_id = ue.id ORDER BY 1) AS labels,
  array(SELECT et.tag FROM entry_tags et WHERE et.user_entry_id = ue.id ORDER BY 1) AS tags,
  left(e.content, 4000) AS head${withContent ? sql`, e.content, e.full_content` : sql``}`;

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
    score: row.score,
    note: row.note,
    labels: row.labels,
    tags: row.tags,
    shareId: row.share_id,
    readAt: row.read_at,
    contentVersion: row.content_version,
    excerpt: excerpt(row.head),
    ...(row.content !== undefined && { content: row.content }),
    ...(row.full_content !== undefined && { fullContent: row.full_content }),
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

/** Conditions for `ListOptions` flags and sort-time bounds. */
function filters(options: Pick<ListOptions, 'flags' | 'sortedFrom' | 'sortedBefore'>): SQL {
  const parts: SQL[] = [];
  const { unread, starred } = options.flags ?? {};
  if (unread !== undefined) parts.push(unread ? sql` AND ue.unread` : sql` AND NOT ue.unread`);
  if (starred !== undefined) parts.push(starred ? sql` AND ue.starred` : sql` AND NOT ue.starred`);
  if (options.sortedFrom)
    parts.push(sql` AND ue.sort_at >= ${options.sortedFrom.toISOString()}::timestamptz`);
  if (options.sortedBefore)
    parts.push(sql` AND ue.sort_at < ${options.sortedBefore.toISOString()}::timestamptz`);
  return sql.join(parts);
}

const STATE_FLAGS = ['unread', 'starred', 'published', 'score'] as const;
type StateFlag = (typeof STATE_FLAGS)[number];

export class EntryService {
  readonly #db: Db;
  readonly #realtime: Realtime;
  readonly #selectiveMatches: number;
  readonly #pageContentBytes: number;

  constructor(
    db: Db,
    realtime: Realtime,
    options: { selectiveMatches?: number; pageContentBytes?: number } = {},
  ) {
    this.#db = db;
    this.#realtime = realtime;
    this.#selectiveMatches = options.selectiveMatches ?? SELECTIVE_MATCHES;
    this.#pageContentBytes = options.pageContentBytes ?? PAGE_CONTENT_BYTES;
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
    const stream = shownCondition(userId, options.stream);
    const view = cursor?.v ?? (await this.#resolveView(stream, options.view));
    const where = sql`${stream}${view === 'unread' ? sql` AND ue.unread` : sql``}${
      options.sinceId === undefined ? sql`` : sql` AND ue.id > ${options.sinceId}`
    }${filters(options)}`;
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
    const offset = cursor && 'o' in cursor ? cursor.o : (options.offset ?? 0);
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
        ${cursor ? sql`` : sql`OFFSET ${offset}`} LIMIT ${options.limit + 1}`);
      rows = result.rows;
    }

    const size = options.content
      ? this.#fitContent(
          rows.map((r) => contentBytes(r.content, r.full_content)),
          options.limit,
        )
      : options.limit;
    const page = rows.slice(0, size);
    const last = page.at(-1);
    let next: Cursor | null = null;
    if (rows.length > size && last) {
      if (order === 'relevance') next = { v: view, o: offset + size };
      else if (last.k != null) next = { v: view, k: last.k, i: Number(last.id) };
    }
    const entries = page.map(toEntry);
    if (options.content || options.enclosures) await this.#attachEnclosures(page, entries);
    return { entries, cursor: next && encodeCursor(next), view };
  }

  /**
   * Ids of entries in `stream`, newest or oldest first, keyset-paginated; for clients that sync
   * by id lists, so it reads no entry text.
   */
  async listIds(
    userId: number,
    options: IdListOptions,
  ): Promise<{ refs: EntryRef[]; cursor: string | null }> {
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (cursor && !('k' in cursor)) throw new DomainError('invalid_input', 'Invalid cursor');
    const spec = orderSpec(options.order ?? 'newest', options.stream);
    const comparison = spec.direction === 'DESC' ? sql`<` : sql`>`;
    const after = cursor
      ? sql` AND (${spec.key}, ue.id) ${comparison} (${cursor.k}::${spec.keyType}, ${cursor.i})`
      : sql``;
    const direction = sql.raw(spec.direction === 'DESC' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST');
    const result = await this.#db.execute<{
      id: string;
      subscription_id: number | null;
      usec: string;
      k: string;
    }>(sql`
      SELECT ue.id, ue.subscription_id, ${spec.key}::text AS k,
        (extract(epoch FROM ue.sort_at) * 1000000)::bigint::text AS usec
      FROM user_entries ue
      WHERE ${shownCondition(userId, options.stream)}${filters(options)}${after}
      ORDER BY ${spec.key} ${direction}, ue.id ${direction}
      LIMIT ${options.limit + 1}`);
    const page = result.rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      refs: page.map((row) => ({
        id: Number(row.id),
        subscriptionId: row.subscription_id,
        sortAtUsec: row.usec,
      })),
      cursor:
        result.rows.length > options.limit && last
          ? encodeCursor({ v: 'all', k: last.k, i: Number(last.id) })
          : null,
    };
  }

  /** The user's entries among `ids`, with content and enclosures, newest first. */
  async getMany(userId: number, ids: number[]): Promise<Entry[]> {
    if (ids.length === 0) return [];
    const result = await this.#db.execute<HeadlineRow>(sql`
      SELECT ${headlineColumns(true)} FROM ${HEADLINE_FROM}
      WHERE ue.user_id = ${userId} AND ue.id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      ORDER BY ue.sort_at DESC, ue.id DESC`);
    const entries = result.rows.map(toEntry);
    await this.#attachEnclosures(result.rows, entries);
    return entries;
  }

  /**
   * Content and enclosures of the user's entries in the order asked, for clients that store
   * articles; those past the content budget (always after the first) are `deferred`, and ids the
   * user does not hold are `missing`.
   */
  async contents(
    userId: number,
    ids: number[],
  ): Promise<{ entries: Entry[]; missing: number[]; deferred: number[] }> {
    const unique = [...new Set(ids)];
    const byId = new Map((await this.getMany(userId, unique)).map((e) => [e.id, e]));
    const found = unique.flatMap((id) => byId.get(id) ?? []);
    const size = this.#fitContent(
      found.map((e) => contentBytes(e.content, e.fullContent)),
      found.length,
    );
    return {
      entries: found.slice(0, size),
      missing: unique.filter((id) => !byId.has(id)),
      deferred: found.slice(size).map((e) => e.id),
    };
  }

  /** How many entries (at most `limit`, at least one) fit the content budget, given their sizes. */
  #fitContent(sizes: number[], limit: number): number {
    let bytes = 0;
    for (const [i, size] of sizes.slice(0, limit).entries()) {
      bytes += size;
      if (bytes > this.#pageContentBytes && i > 0) return i;
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

  /** Sets flags and scores on the user's entries; rows already in that state are left untouched. */
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
    if (state.score !== undefined) {
      set.score = state.score;
      differs.push(ne(userEntries.score, state.score));
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

  /**
   * Compare-and-set for changes made offline and sent late: each flag changes only where it still
   * has the value the client saw (`expect`), or none was given. A flag changed elsewhere since (to
   * neither that value nor the target) keeps the newer value, and its entry is reported with its
   * values now. Entries already at the target count as applied.
   */
  async changeState(
    userId: number,
    ids: number[],
    state: EntryState,
    expect: EntryState,
  ): Promise<{ updated: number; conflicts: StateConflict[] }> {
    const flags = STATE_FLAGS.filter((f) => state[f] !== undefined);
    if (flags.length === 0 || ids.length === 0) return { updated: 0, conflicts: [] };
    const column = {
      unread: userEntries.unread,
      starred: userEntries.starred,
      published: userEntries.published,
      score: userEntries.score,
    };
    const value = (flag: StateFlag, v: boolean | number | undefined) =>
      flag === 'score' ? sql`${v}::integer` : sql`${v}::boolean`;
    const applies = (flag: StateFlag) =>
      expect[flag] === undefined ? sql`true` : sql`${column[flag]} = ${value(flag, expect[flag])}`;
    const changed = (flag: StateFlag) => sql`${column[flag]} <> ${value(flag, state[flag])}`;
    const conflicting = flags
      .filter((f) => expect[f] !== undefined)
      .map((f) => sql`(NOT ${applies(f)} AND ${changed(f)})`);
    const mine = and(eq(userEntries.userId, userId), inArray(userEntries.id, ids));
    const { updated, conflicts } = await this.#db.transaction(async (tx) => {
      const conflicts =
        conflicting.length > 0
          ? await tx
              .select({
                id: userEntries.id,
                unread: userEntries.unread,
                starred: userEntries.starred,
                published: userEntries.published,
                score: userEntries.score,
              })
              .from(userEntries)
              .where(and(mine, or(...conflicting)))
          : [];
      const set: PgUpdateSetSource<typeof userEntries> = {};
      for (const flag of flags)
        set[flag] =
          sql`CASE WHEN ${applies(flag)} THEN ${value(flag, state[flag])} ELSE ${column[flag]} END`;
      if (state.unread !== undefined)
        set.readAt = sql`CASE WHEN ${applies('unread')} AND ${changed('unread')}
          THEN ${state.unread ? sql`NULL` : sql`now()`} ELSE ${userEntries.readAt} END`;
      const updated = await tx
        .update(userEntries)
        .set(set)
        .where(and(mine, or(...flags.map((f) => sql`(${applies(f)} AND ${changed(f)})`))))
        .returning({ id: userEntries.id });
      return { updated: updated.length, conflicts };
    });
    if (updated > 0) await this.#realtime.publish(userId, { type: 'counters' });
    return {
      updated,
      conflicts: conflicts.map(({ id, ...current }) => ({ id, current })),
    };
  }

  /** Flips one flag on the user's entries; returns how many changed. */
  async toggle(
    userId: number,
    ids: number[],
    flag: 'unread' | 'starred' | 'published',
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const set: PgUpdateSetSource<typeof userEntries> =
      flag === 'unread'
        ? {
            unread: sql`NOT ${userEntries.unread}`,
            readAt: sql`CASE WHEN ${userEntries.unread} THEN now() END`,
          }
        : flag === 'starred'
          ? { starred: sql`NOT ${userEntries.starred}` }
          : { published: sql`NOT ${userEntries.published}` };
    const updated = await this.#db
      .update(userEntries)
      .set(set)
      .where(and(eq(userEntries.userId, userId), inArray(userEntries.id, ids)))
      .returning({ id: userEntries.id });
    if (updated.length > 0) await this.#realtime.publish(userId, { type: 'counters' });
    return updated.length;
  }

  /** Sets or, with null or blank text, clears the user's note on an entry. */
  /**
   * Sets the note; null or blank text clears it. With `expected` (the note the client saw), a note
   * changed elsewhere since is kept and `conflict` thrown, unless it already is the new text.
   */
  async setNote(
    userId: number,
    id: number,
    note: string | null,
    expected?: string | null,
  ): Promise<void> {
    const text = note?.trim() || null;
    const mine = and(eq(userEntries.userId, userId), eq(userEntries.id, id));
    const unchanged =
      expected === undefined
        ? undefined
        : sql`(${userEntries.note} IS NOT DISTINCT FROM ${expected?.trim() || null}::text
            OR ${userEntries.note} IS NOT DISTINCT FROM ${text}::text)`;
    const updated = await this.#db
      .update(userEntries)
      .set({ note: text })
      .where(and(mine, unchanged))
      .returning({ id: userEntries.id });
    if (updated.length > 0) return;
    const [exists] = await this.#db.select({ id: userEntries.id }).from(userEntries).where(mine);
    if (!exists) throw new DomainError('not_found', 'Entry not found');
    throw new DomainError('conflict', 'The note was changed on another device');
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
   * `olderThanDays`, with an id up to `maxId`, or delivered to the user by `deliveredBy`.
   */
  async markRead(
    userId: number,
    stream: Stream,
    options: {
      olderThanDays?: number | undefined;
      maxId?: number | undefined;
      deliveredBy?: Date | undefined;
    } = {},
  ): Promise<number> {
    const older =
      options.olderThanDays === undefined
        ? sql``
        : sql` AND ue.sort_at < now() - make_interval(days => ${options.olderThanDays})`;
    const upTo = options.maxId === undefined ? sql`` : sql` AND ue.id <= ${options.maxId}`;
    const delivered =
      options.deliveredBy === undefined
        ? sql``
        : sql` AND ue.created_at <= ${options.deliveredBy.toISOString()}::timestamptz`;
    const result = await this.#db.execute(sql`
      UPDATE user_entries ue SET unread = false, read_at = now()
      WHERE ${streamCondition(userId, stream)} AND ue.unread${older}${upTo}${delivered}`);
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
