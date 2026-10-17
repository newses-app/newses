import { describe, expect, it } from 'vitest';
import { DEFAULT_KEEP, keeps, readCutoff, upsertById } from './offline-keep.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe('keeps', () => {
  it('keeps unread, starred, and recently read entries', () => {
    expect(keeps({ unread: true, starred: false, readAt: null }, NOW)).toBe(true);
    expect(keeps({ unread: false, starred: true, readAt: daysAgo(30) }, NOW)).toBe(true);
    expect(keeps({ unread: false, starred: false, readAt: daysAgo(6) }, NOW)).toBe(true);
    expect(keeps({ unread: false, starred: false, readAt: daysAgo(8) }, NOW)).toBe(false);
    expect(keeps({ unread: false, starred: false, readAt: null }, NOW)).toBe(false);
  });

  it('cuts read entries off at the configured days', () => {
    expect(readCutoff(NOW, DEFAULT_KEEP)).toBe(daysAgo(7));
    expect(
      keeps({ unread: false, starred: false, readAt: daysAgo(2) }, NOW, {
        ...DEFAULT_KEEP,
        readDays: 1,
      }),
    ).toBe(false);
  });
});

describe('upsertById', () => {
  it('replaces in place, appends new rows, and drops deleted ones', () => {
    const list = [
      { id: 1, t: 'a' },
      { id: 2, t: 'b' },
      { id: 3, t: 'c' },
    ];
    expect(
      upsertById(
        list,
        [
          { id: 2, t: 'B' },
          { id: 4, t: 'd' },
          { id: 5, t: 'gone' },
        ],
        [3, 5],
      ),
    ).toEqual([
      { id: 1, t: 'a' },
      { id: 2, t: 'B' },
      { id: 4, t: 'd' },
    ]);
  });
});
