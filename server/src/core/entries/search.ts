import {
  parseSearchQuery,
  type SearchField,
  type SearchFilter,
  type SearchLanguage,
  searchLanguage,
  type SearchTerm,
  searchDayRange,
} from '@newses/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';

/** A search, read for the database: the full-text query and the filters' conditions. */
export interface EntrySearch {
  /** The full-text query of the free text (see `textQuery`); null when there is none. */
  text: SQL | null;
  /** Conditions on the user's entries (`ue`) and their entries (`e`), each after ` AND `. */
  where: SQL;
}

export interface SearchContext {
  /** IANA time zone dates are read in; UTC when not given. */
  timeZone?: string | undefined;
  now?: Date | undefined;
  /** Languages the free text's words are stemmed in, besides matching them folded. */
  languages?: (() => Promise<readonly SearchLanguage[]>) | undefined;
}

/** Folded to lower case without accents, as search matches text. */
export const folded = (text: SQL) => sql`unaccent(lower(${text}))`;

/** `column` holds `value`, ignoring case and accents. */
export const contains = (column: SQL, value: string) =>
  sql`strpos(${folded(sql`coalesce(${column}, '')`)}, ${folded(sql`${value}`)}) > 0`;

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

/**
 * The full-text query of a search's free text: every group matches, a group when one of its
 * terms does, and a term when its words do folded or stemmed in one of `languages` (or, negated,
 * in none of them).
 */
export function textQuery(
  groups: SearchTerm[][],
  languages: readonly SearchLanguage[],
): SQL | null {
  if (groups.length === 0) return null;
  const configs = ['newses_simple', ...languages.map((l) => `newses_${l}`)];
  const term = (t: SearchTerm) => {
    // Quoted, so the term's own characters are never operators.
    const forms = sql.join(
      configs.map((c) => sql`websearch_to_tsquery(${c}::regconfig, ${`"${t.value}"`})`),
      sql` || `,
    );
    return t.negated ? sql`!!(${forms})` : sql`(${forms})`;
  };
  return sql`(${sql.join(
    groups.map((g) => sql`(${sql.join(g.map(term), sql` || `)})`),
    sql` && `,
  )})`;
}

/**
 * Languages to stem a user's searches in: those of their feeds (their newest entry's) and of
 * their app, where search has a stemmer.
 */
export async function searchLanguages(db: Db, userId: number): Promise<SearchLanguage[]> {
  const result = await db.execute<{ lang: string | null }>(sql`
    SELECT (SELECT e.lang FROM entries e WHERE e.feed_source_id = s.feed_source_id
        ORDER BY e.published_at DESC LIMIT 1) AS lang
      FROM subscriptions s WHERE s.user_id = ${userId}
    UNION
    SELECT value #>> '{}' FROM user_prefs WHERE user_id = ${userId} AND key = 'language'`);
  const languages = result.rows.map((r) => searchLanguage(r.lang));
  return [...new Set(languages.filter((l) => l !== null))].sort();
}

/** Reads `q` (see `parseSearchQuery`) for a search of the user's entries. */
export async function entrySearch(q: string, context: SearchContext = {}): Promise<EntrySearch> {
  const query = parseSearchQuery(q);
  const languages = query.groups.length > 0 ? ((await context.languages?.()) ?? []) : [];
  return {
    text: textQuery(query.groups, languages),
    where: sql.join(query.filters.map((f) => sql` AND ${condition(f, context)}`)),
  };
}
