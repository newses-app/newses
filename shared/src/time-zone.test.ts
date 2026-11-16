import { describe, expect, it } from 'vitest';
import { isTimeZone, nextOccurrence, wallClock } from './time-zone.ts';

const at = (iso: string) => new Date(iso);

describe('isTimeZone', () => {
  it('knows IANA zones only', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('wallClock', () => {
  it('reads the calendar in the zone', () => {
    expect(wallClock(at('2026-06-15T22:30:00Z').getTime(), 'Pacific/Auckland')).toEqual({
      year: 2026,
      month: 6,
      day: 16,
      hour: 10,
      minute: 30,
      second: 0,
    });
  });
});

describe('nextOccurrence', () => {
  it('is later today, or else tomorrow', () => {
    expect(nextOccurrence(at('2026-06-15T05:00:00Z'), 'Europe/Berlin', 9)).toEqual(
      at('2026-06-15T07:00:00Z'),
    );
    expect(nextOccurrence(at('2026-06-15T07:00:00Z'), 'Europe/Berlin', 9)).toEqual(
      at('2026-06-16T07:00:00Z'),
    );
  });

  it('counts days in the zone, not in UTC', () => {
    // 08:00 on the 16th in Auckland.
    expect(nextOccurrence(at('2026-06-15T20:00:00Z'), 'Pacific/Auckland', 7)).toEqual(
      at('2026-06-16T19:00:00Z'),
    );
    expect(nextOccurrence(at('2026-06-15T20:00:00Z'), 'Pacific/Auckland', 9)).toEqual(
      at('2026-06-15T21:00:00Z'),
    );
  });

  it('keeps the hour across clock changes', () => {
    // Berlin springs forward on 29 March and falls back on 25 October 2026.
    expect(nextOccurrence(at('2026-03-28T06:00:00Z'), 'Europe/Berlin', 7)).toEqual(
      at('2026-03-29T05:00:00Z'),
    );
    expect(nextOccurrence(at('2026-10-24T05:00:00Z'), 'Europe/Berlin', 7)).toEqual(
      at('2026-10-25T06:00:00Z'),
    );
  });

  it('moves an hour a clock change skips to the hour after', () => {
    expect(nextOccurrence(at('2026-03-28T12:00:00Z'), 'Europe/Berlin', 2)).toEqual(
      at('2026-03-29T01:00:00Z'),
    );
  });

  it('happens once on the day an hour repeats', () => {
    const first = nextOccurrence(at('2026-10-24T12:00:00Z'), 'Europe/Berlin', 2);
    expect(first).toEqual(at('2026-10-25T01:00:00Z'));
    expect(nextOccurrence(first, 'Europe/Berlin', 2)).toEqual(at('2026-10-26T01:00:00Z'));
  });

  it('waits for the weekday', () => {
    // Sunday 1 November 2026, the day New York falls back; Monday the 2nd at 09:00 EST.
    expect(nextOccurrence(at('2026-11-01T12:00:00Z'), 'America/New_York', 9, 1)).toEqual(
      at('2026-11-02T14:00:00Z'),
    );
    // Monday at 10:00: a week on.
    expect(nextOccurrence(at('2026-11-02T15:00:00Z'), 'America/New_York', 9, 1)).toEqual(
      at('2026-11-09T14:00:00Z'),
    );
    expect(nextOccurrence(at('2026-11-02T13:00:00Z'), 'America/New_York', 9, 1)).toEqual(
      at('2026-11-02T14:00:00Z'),
    );
  });
});
