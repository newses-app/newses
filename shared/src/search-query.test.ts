import { describe, expect, it } from 'vitest';
import { isTimeZone, parseSearchQuery, searchDayRange } from './search-query.ts';

describe('parseSearchQuery', () => {
  it('keeps free text as written, quotes, OR, and negation included', () => {
    expect(parseSearchQuery('rust "async io" OR tokio -nightly')).toEqual({
      text: 'rust "async io" OR tokio -nightly',
      terms: [
        { value: 'rust', negated: false },
        { value: 'async io', negated: false },
        { value: 'tokio', negated: false },
        { value: 'nightly', negated: true },
      ],
      filters: [],
    });
  });

  it('reads field operators, quoted values, and negation', () => {
    expect(
      parseSearchQuery('TITLE:Rust author:"Jane  Doe" -note:draft tag:" Big News " -label:Later')
        .filters,
    ).toEqual([
      { kind: 'field', field: 'title', value: 'Rust', negated: false },
      { kind: 'field', field: 'author', value: 'Jane Doe', negated: false },
      { kind: 'field', field: 'note', value: 'draft', negated: true },
      { kind: 'field', field: 'tag', value: 'big news', negated: false },
      { kind: 'field', field: 'label', value: 'Later', negated: true },
    ]);
  });

  it('folds negation into flags and note:true/false', () => {
    expect(
      parseSearchQuery('unread:true star:FALSE -pub:true note:true -note:true').filters,
    ).toEqual([
      { kind: 'flag', flag: 'unread', value: true },
      { kind: 'flag', flag: 'starred', value: false },
      { kind: 'flag', flag: 'published', value: false },
      { kind: 'hasNote', value: true },
      { kind: 'hasNote', value: false },
    ]);
  });

  it('reads dates', () => {
    expect(parseSearchQuery('@2024-02-29 -@today @yesterday @-3days @-1week').filters).toEqual([
      { kind: 'date', date: { day: '2024-02-29' }, negated: false },
      { kind: 'date', date: { daysAgo: 0 }, negated: true },
      { kind: 'date', date: { daysAgo: 1 }, negated: false },
      { kind: 'date', date: { daysAgo: 3 }, negated: false },
      { kind: 'date', date: { daysAgo: 7 }, negated: false },
    ]);
  });

  it('leaves unknown operators, values, and dates as free text', () => {
    const query = parseSearchQuery('https://example.com unread:maybe @2023-02-30 @soon title: -');
    expect(query.filters).toEqual([]);
    expect(query.text).toBe('https://example.com unread:maybe @2023-02-30 @soon title: -');
    expect(query.terms.map((t) => t.value)).toEqual([
      'https://example.com',
      'unread:maybe',
      '@2023-02-30',
      '@soon',
      'title:',
    ]);
  });

  it('keeps a quoted operator as a phrase', () => {
    expect(parseSearchQuery('"title:rust"')).toEqual({
      text: '"title:rust"',
      terms: [{ value: 'title:rust', negated: false }],
      filters: [],
    });
  });

  it('separates operators from the free text around them', () => {
    const query = parseSearchQuery('  release  star:true notes ');
    expect(query.text).toBe('release notes');
    expect(query.filters).toHaveLength(1);
  });
});

describe('searchDayRange', () => {
  const now = new Date('2024-03-31T12:00:00Z');

  it('spans a calendar day in the time zone', () => {
    expect(searchDayRange({ day: '2024-03-10' }, 'UTC', now)).toEqual({
      from: new Date('2024-03-10T00:00:00Z'),
      to: new Date('2024-03-11T00:00:00Z'),
    });
    expect(searchDayRange({ day: '2024-01-15' }, 'Asia/Tokyo', now)).toEqual({
      from: new Date('2024-01-14T15:00:00Z'),
      to: new Date('2024-01-15T15:00:00Z'),
    });
  });

  it('follows daylight saving time', () => {
    // Clocks go forward on 2024-03-10 in New York: a 23-hour day.
    expect(searchDayRange({ day: '2024-03-10' }, 'America/New_York', now)).toEqual({
      from: new Date('2024-03-10T05:00:00Z'),
      to: new Date('2024-03-11T04:00:00Z'),
    });
  });

  it('counts relative days back from today in the time zone', () => {
    // 12:00 UTC is already the next day in Auckland (UTC+13).
    expect(searchDayRange({ daysAgo: 0 }, 'Pacific/Auckland', now).from).toEqual(
      new Date('2024-03-31T11:00:00Z'),
    );
    expect(searchDayRange({ daysAgo: 1 }, 'UTC', now)).toEqual({
      from: new Date('2024-03-30T00:00:00Z'),
      to: new Date('2024-03-31T00:00:00Z'),
    });
  });
});

describe('isTimeZone', () => {
  it('knows IANA zones only', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});
