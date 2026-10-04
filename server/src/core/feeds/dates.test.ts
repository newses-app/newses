import { describe, expect, it } from 'vitest';
import { parseFeedDate } from './dates.ts';

describe('parseFeedDate', () => {
  it.each([
    ['Sat, 03 Oct 2026 14:00:00 +0000', '2026-10-03T14:00:00.000Z'],
    ['Sat, 3 Oct 2026 14:00:00 EDT', '2026-10-03T18:00:00.000Z'],
    ['03 Oct 2026 14:00 GMT', '2026-10-03T14:00:00.000Z'],
    ['2026-10-03T09:30:00+02:00', '2026-10-03T07:30:00.000Z'],
    ['2026-10-03 14:00:00', '2026-10-03T14:00:00.000Z'],
    ['Sat, 03 Oct 2026 14:00:00', '2026-10-03T14:00:00.000Z'],
    ['2026-10-03', '2026-10-03T00:00:00.000Z'],
  ])('%s', (input, expected) => {
    expect(parseFeedDate(input)?.toISOString()).toBe(expected);
  });

  it.each(['not a date', '', undefined, null, 42])('returns null for %j', (input) => {
    expect(parseFeedDate(input)).toBeNull();
  });
});
