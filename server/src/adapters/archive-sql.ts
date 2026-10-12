import type { ArchivedEnclosure, ArchiveListQuery, ArchiveRow } from '../core/ports.ts';
import {
  ARCHIVE_COLUMNS,
  archiveMonth,
  ENCLOSURE_FIELDS,
  ENCLOSURES_COLUMN,
} from './archive-format.ts';

// Archive queries in the SQL that DuckDB and Athena (Trino) share; each reader supplies the few
// expressions that differ. Parameters are positional `?`.

export interface ArchiveDialect {
  /** The table (or table function) of every archive file, with the `month` partition column. */
  table: string;
  /** Epoch milliseconds of a timestamp column, as a BIGINT. */
  ms(column: string): string;
  /** A list column as JSON text. */
  json(column: string): string;
}

export type Param = string | number;

export interface Statement {
  sql: string;
  params: Param[];
}

/** Headline text is cut to this many characters. */
const HEADLINE_TEXT = 300;

const TIMES = ['published_at', 'source_updated_at', 'fetched_at', 'sort_at', 'archived_at'];
const PLAIN = ['id', 'feed_url', 'feed_title', 'guid', 'link', 'title', 'author', 'lang'];

/**
 * Rows matching `where`, one per feed URL and GUID (the one archived last), in the archive's
 * order: newest `sort_at` first, then feed URL and GUID, descending.
 */
function select(
  d: ArchiveDialect,
  where: Statement,
  after: Statement | null,
  limit: number,
  full: boolean,
): Statement {
  const columns = [
    ...PLAIN,
    ...TIMES.map((t) => `${d.ms(t)} AS ${t.replace(/_at$/, '_ms')}`),
    full ? 'text' : `substr(text, 1, ${String(HEADLINE_TEXT)}) AS text`,
    ...(full ? ['content', `${d.json('enclosures')} AS enclosures`] : []),
  ];
  const names = columns.map((c) => c.split(' AS ').at(-1) ?? c);
  return {
    sql: `SELECT ${names.join(', ')} FROM (
  SELECT ${columns.join(', ')},
    row_number() OVER (PARTITION BY feed_url, guid ORDER BY archived_at DESC) AS rn
  FROM ${d.table}
  WHERE ${where.sql}
) x
WHERE rn = 1${after ? ` AND ${after.sql}` : ''}
ORDER BY sort_ms DESC, feed_url DESC, guid DESC
LIMIT ${String(Math.max(1, Math.trunc(limit)))}`,
    params: [...where.params, ...(after?.params ?? [])],
  };
}

export function listStatement(d: ArchiveDialect, query: ArchiveListQuery): Statement {
  const conditions = [`feed_url IN (${query.feedUrls.map(() => '?').join(', ')})`];
  const params: Param[] = [...query.feedUrls];
  if (query.after) {
    conditions.push('month <= ?');
    params.push(archiveMonth(query.after));
  }
  for (const term of query.terms) {
    conditions.push(`strpos(lower(coalesce(title, '') || ' ' || coalesce(text, '')), ?) > 0`);
    params.push(term);
  }
  const { after } = query;
  const ms = after?.sortAt.getTime() ?? 0;
  return select(
    d,
    { sql: conditions.join(' AND '), params },
    after && {
      sql: '(sort_ms < ? OR (sort_ms = ? AND (feed_url < ? OR (feed_url = ? AND guid < ?))))',
      params: [ms, ms, after.feedUrl, after.feedUrl, after.guid],
    },
    query.limit,
    false,
  );
}

export function getStatement(
  d: ArchiveDialect,
  month: string,
  feedUrl: string,
  guid: string,
): Statement {
  return select(
    d,
    { sql: 'month = ? AND feed_url = ? AND guid = ?', params: [month, feedUrl, guid] },
    null,
    1,
    true,
  );
}

const FILE_COLUMNS = [...ARCHIVE_COLUMNS.map((c) => c.name), ENCLOSURES_COLUMN].join(', ');

/**
 * The newest copy of each article in `table` (rows matching `where`), with the columns of an
 * archive file and sorted as one, for compaction.
 */
export function compactedSql(table: string, where = 'true'): string {
  return `SELECT ${FILE_COLUMNS} FROM (
  SELECT ${FILE_COLUMNS},
    row_number() OVER (PARTITION BY feed_url, guid ORDER BY archived_at DESC) AS rn
  FROM ${table}
  WHERE ${where}
) x WHERE rn = 1 ORDER BY feed_url, sort_at`;
}

/** Quotes a string as an SQL literal. */
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

const text = (value: unknown) =>
  value === null || value === undefined
    ? null
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
const time = (value: unknown) =>
  value === null || value === undefined ? null : new Date(Number(value));

/** Enclosures from JSON: objects by field name, or (from some engines) arrays in field order. */
function enclosures(json: unknown): ArchivedEnclosure[] {
  if (typeof json !== 'string' || !json) return [];
  const list = JSON.parse(json) as (Record<string, unknown> | unknown[])[] | null;
  return (list ?? []).map((item) => {
    const value = (i: number) => {
      const field = ENCLOSURE_FIELDS[i];
      if (!field) return null;
      return Array.isArray(item) ? item[i] : item[field.name];
    };
    const num = (i: number) => {
      const v = value(i);
      return v === null || v === undefined ? null : Number(v);
    };
    return {
      url: String(value(0)),
      mimeType: text(value(1)),
      length: num(2),
      width: num(3),
      height: num(4),
      durationSeconds: num(5),
    };
  });
}

/** An archive row from a result row of `listStatement` or `getStatement`, values as text or numbers. */
export function parseRow(row: Record<string, unknown>): ArchiveRow {
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    feedUrl: String(row.feed_url),
    feedTitle: text(row.feed_title),
    guid: String(row.guid),
    link: text(row.link),
    title: text(row.title),
    author: text(row.author),
    content: text(row.content),
    text: text(row.text),
    lang: text(row.lang),
    publishedAt: time(row.published_ms),
    sourceUpdatedAt: time(row.source_updated_ms),
    fetchedAt: time(row.fetched_ms) ?? new Date(0),
    sortAt: time(row.sort_ms) ?? new Date(0),
    archivedAt: time(row.archived_ms) ?? new Date(0),
    enclosures: enclosures(row.enclosures),
  };
}
