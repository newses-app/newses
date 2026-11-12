// Search query syntax (TTRSS's operators), read the same way by the server, the archive, and
// offline search. No Zod, so browsers can import it.

import { normaliseTag } from './limits.ts';

/** Fields matched by their text: a substring, ignoring case; tags and labels whole. */
export type SearchField = 'title' | 'author' | 'note' | 'tag' | 'label';
export type SearchFlag = 'unread' | 'starred' | 'published';

/** A day: a calendar date, or so many days before today. */
export type SearchDate = { day: string } | { daysAgo: number };

export type SearchFilter =
  | { kind: 'field'; field: SearchField; value: string; negated: boolean }
  /** `note:true` or `note:false`, with negation folded in. */
  | { kind: 'hasNote'; value: boolean }
  /** `unread:`, `star:`, or `pub:`, with negation folded in. */
  | { kind: 'flag'; flag: SearchFlag; value: boolean }
  | { kind: 'date'; date: SearchDate; negated: boolean };

/** A word or phrase of the free text, without its quotes. */
export interface SearchTerm {
  value: string;
  negated: boolean;
  /** Written in quotes. */
  phrase: boolean;
}

export interface SearchQuery {
  /** The free text, in the full-text search's syntax (quotes, `OR`, `-`); empty when none. */
  text: string;
  /** The free text's words and phrases, without `OR`. */
  terms: SearchTerm[];
  /** The free text as alternatives (terms joined by `OR`) that must all match. */
  groups: SearchTerm[][];
  filters: SearchFilter[];
}

const FIELDS: Record<string, SearchField> = {
  title: 'title',
  author: 'author',
  note: 'note',
  tag: 'tag',
  label: 'label',
};
const FLAGS: Record<string, SearchFlag> = { unread: 'unread', star: 'starred', pub: 'published' };

/** Splits on spaces outside double quotes; quotes stay in the tokens. */
function tokens(q: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const c of q) {
    if (c === '"') quoted = !quoted;
    if (!quoted && /\s/u.test(c)) {
      if (current) out.push(current);
      current = '';
    } else current += c;
  }
  if (current) out.push(current);
  return out;
}

const unquote = (text: string) => text.replaceAll('"', '').replace(/\s+/gu, ' ').trim();

function bool(value: string): boolean | null {
  const lower = value.toLowerCase();
  return lower === 'true' ? true : lower === 'false' ? false : null;
}

function validDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1;
}

/** `YYYY-MM-DD`, `today`, `yesterday`, or `-N day(s)` and `-N week(s)` written without spaces. */
function parseDate(text: string): SearchDate | null {
  const lower = text.toLowerCase();
  if (lower === 'today') return { daysAgo: 0 };
  if (lower === 'yesterday') return { daysAgo: 1 };
  const relative = /^-(\d{1,4})(days?|weeks?)$/.exec(lower);
  if (relative) {
    const n = Number(relative[1]);
    return { daysAgo: relative[2]?.startsWith('week') ? n * 7 : n };
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lower);
  if (day && validDay(Number(day[1]), Number(day[2]), Number(day[3]))) return { day: lower };
  return null;
}

/** The filter an operator token stands for; null when it is free text. */
function parseFilter(body: string, negated: boolean): SearchFilter | null {
  if (body.startsWith('@')) {
    const date = parseDate(unquote(body.slice(1)));
    return date && { kind: 'date', date, negated };
  }
  const match = /^([a-z]+):(.+)$/isu.exec(body);
  if (!match?.[1] || match[2] === undefined) return null;
  const key = match[1].toLowerCase();
  const value = unquote(match[2]);
  if (!value) return null;
  const flag = FLAGS[key];
  if (flag) {
    const b = bool(value);
    return b === null ? null : { kind: 'flag', flag, value: b !== negated };
  }
  const field = FIELDS[key];
  if (!field) return null;
  if (field === 'note') {
    const b = bool(value);
    if (b !== null) return { kind: 'hasNote', value: b !== negated };
  }
  if (field === 'tag') {
    const tag = normaliseTag(value);
    return tag === null ? null : { kind: 'field', field, value: tag, negated };
  }
  return { kind: 'field', field, value, negated };
}

/**
 * Reads a search: operators (`title:`, `author:`, `note:`, `tag:`, `label:`, `unread:`, `star:`,
 * `pub:`, `@date`, each negated by a leading `-`, values quoted when they have spaces) become
 * filters; everything else is free text. Unknown operators and values are free text.
 */
export function parseSearchQuery(q: string): SearchQuery {
  const free: string[] = [];
  const terms: SearchTerm[] = [];
  const groups: SearchTerm[][] = [];
  const filters: SearchFilter[] = [];
  let or = false;
  for (const token of tokens(q)) {
    const negated = token.length > 1 && token.startsWith('-');
    const body = negated ? token.slice(1) : token;
    const filter = parseFilter(body, negated);
    if (filter) {
      filters.push(filter);
      continue;
    }
    free.push(token);
    if (token === 'OR') {
      or = groups.length > 0;
      continue;
    }
    const value = unquote(body);
    if (!/[\p{L}\p{N}]/u.test(value)) continue;
    const term = { value, negated, phrase: body.includes('"') };
    terms.push(term);
    const last = groups.at(-1);
    if (or && last) last.push(term);
    else groups.push([term]);
    or = false;
  }
  return { text: free.join(' '), terms, groups, filters };
}

/** This device's IANA time zone. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Whether `timeZone` is an IANA time zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar fields of `instant` in `timeZone`. */
function fields(instant: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function offset(instant: number, timeZone: string): number {
  const f = fields(instant, timeZone);
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant a calendar day (as UTC midnight of that date) begins in `timeZone`. */
function startOfDay(utcMidnight: number, timeZone: string): number {
  const guess = utcMidnight - offset(utcMidnight, timeZone);
  return utcMidnight - offset(guess, timeZone);
}

/**
 * The instants a search date's day begins (inclusive) and ends (exclusive) in `timeZone`, with
 * relative days counted back from `now`.
 */
export function searchDayRange(
  date: SearchDate,
  timeZone: string,
  now: Date,
): { from: Date; to: Date } {
  let midnight: number;
  if ('day' in date) {
    const [y, m, d] = date.day.split('-').map(Number) as [number, number, number];
    midnight = Date.UTC(y, m - 1, d);
  } else {
    const today = fields(now.getTime(), timeZone);
    midnight = Date.UTC(today.year, today.month - 1, today.day - date.daysAgo);
  }
  return {
    from: new Date(startOfDay(midnight, timeZone)),
    to: new Date(startOfDay(midnight + 86_400_000, timeZone)),
  };
}
