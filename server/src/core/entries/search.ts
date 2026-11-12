import {
  parseSearchQuery,
  type SearchField,
  type SearchFilter,
  searchDayRange,
} from '@newses/shared';
import { type SQL, sql } from 'drizzle-orm';

/** A search, read for the database: the full-text query and the filters' conditions. */
export interface EntrySearch {
  /** `websearch_to_tsquery` of the free text; null when there is none. */
  text: SQL | null;
  /** Conditions on the user's entries (`ue`) and their entries (`e`), each after ` AND `. */
  where: SQL;
}

export interface SearchContext {
  /** IANA time zone dates are read in; UTC when not given. */
  timeZone?: string | undefined;
  now?: Date | undefined;
}

const contains = (column: SQL, value: string) =>
  sql`strpos(lower(coalesce(${column}, '')), lower(${value})) > 0`;

const FLAG_COLUMNS = {
  unread: sql`ue.unread`,
  starred: sql`ue.starred`,
  published: sql`ue.published`,
};

function condition(filter: SearchFilter, context: SearchContext): SQL {
  switch (filter.kind) {
    case 'flag':
      return filter.value ? FLAG_COLUMNS[filter.flag] : sql`NOT ${FLAG_COLUMNS[filter.flag]}`;
    case 'hasNote':
      return filter.value ? sql`coalesce(ue.note, '') <> ''` : sql`coalesce(ue.note, '') = ''`;
    case 'date': {
      const { from, to } = searchDayRange(
        filter.date,
        context.timeZone ?? 'UTC',
        context.now ?? new Date(),
      );
      const within = sql`(ue.sort_at >= ${from.toISOString()}::timestamptz AND ue.sort_at < ${to.toISOString()}::timestamptz)`;
      return filter.negated ? sql`NOT ${within}` : within;
    }
    case 'field': {
      const match = fieldMatch(filter.field, filter.value);
      return filter.negated ? sql`NOT ${match}` : match;
    }
  }
}

function fieldMatch(field: SearchField, value: string): SQL {
  switch (field) {
    case 'title':
      return contains(sql`e.title`, value);
    case 'author':
      return contains(sql`e.author`, value);
    case 'note':
      return contains(sql`ue.note`, value);
    case 'tag':
      return sql`EXISTS (SELECT 1 FROM entry_tags et WHERE et.user_entry_id = ue.id AND et.tag = ${value})`;
    case 'label':
      return sql`EXISTS (SELECT 1 FROM entry_labels el JOIN labels l ON l.id = el.label_id
        WHERE el.user_entry_id = ue.id AND lower(l.caption) = lower(${value}))`;
  }
}

/** Reads `q` (see `parseSearchQuery`) for a search of the user's entries. */
export function entrySearch(q: string, context: SearchContext = {}): EntrySearch {
  const query = parseSearchQuery(q);
  return {
    text: query.text ? sql`websearch_to_tsquery('simple', ${query.text})` : null,
    where: sql.join(query.filters.map((f) => sql` AND ${condition(f, context)}`)),
  };
}
