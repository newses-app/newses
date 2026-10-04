import { describe, expect, it } from 'vitest';
import { formatRelative, hostOf } from './format.ts';

describe('format', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  it('formats relative times', () => {
    expect(formatRelative('2026-10-04T09:00:00Z', 'en', now)).toBe('3 hours ago');
    expect(formatRelative('2026-10-03T12:00:00Z', 'en', now)).toBe('yesterday');
    expect(formatRelative('2026-10-04T11:59:40Z', 'en', now)).toBe('this minute');
  });

  it('extracts hosts', () => {
    expect(hostOf('https://news.example/rss')).toBe('news.example');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
