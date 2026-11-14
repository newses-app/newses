import { describe, expect, it } from 'vitest';
import {
  CHECK_STALE_MS,
  checksStale,
  formatBytes,
  formatCount,
  formatMs,
  formatShare,
  splitAlerts,
} from './ops-format.ts';

describe('formatting', () => {
  it('formats counts and shares in the locale', () => {
    expect(formatCount(12345, 'en')).toBe('12,345');
    expect(formatCount(12345, 'de')).toBe('12.345');
    expect(formatShare(1, 3, 'en')).toBe('33%');
    expect(formatShare(0, 0, 'en')).toBe('–');
  });

  it('gives bytes in kilobytes, and megabytes from a million', () => {
    expect(formatBytes(1500, 'en')).toBe('1.5 kB');
    expect(formatBytes(2_500_000, 'en')).toBe('2.5 MB');
  });

  it('gives durations in milliseconds, and seconds from a second', () => {
    expect(formatMs(250, 'en')).toBe('250 ms');
    expect(formatMs(1500, 'en')).toBe('1.5 sec');
    expect(formatMs(1000, 'en')).toBe('1.0 sec');
  });
});

describe('checksStale', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const at = (ms: number) => ({ checkedAt: new Date(now - ms).toISOString() });

  it('is stale after an hour without a check, or with none ever', () => {
    expect(checksStale(at(CHECK_STALE_MS + 1), now)).toBe(true);
    expect(checksStale({ checkedAt: null }, now)).toBe(true);
    expect(checksStale(at(CHECK_STALE_MS), now)).toBe(false);
  });

  it('is not stale before the summary arrives', () => {
    expect(checksStale(undefined, now)).toBe(false);
  });
});

describe('splitAlerts', () => {
  it('separates open alerts from resolved ones, keeping their order', () => {
    const alerts = [
      { id: 1, resolvedAt: null },
      { id: 2, resolvedAt: '2026-11-14T10:00:00Z' },
      { id: 3, resolvedAt: null },
    ];
    const { open, resolved } = splitAlerts(alerts);
    expect(open.map((a) => a.id)).toEqual([1, 3]);
    expect(resolved.map((a) => a.id)).toEqual([2]);
    expect(splitAlerts(undefined)).toEqual({ open: [], resolved: [] });
  });
});
