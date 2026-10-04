import { describe, expect, it } from 'vitest';
import { normalizeFeedUrl } from './url.ts';

describe('normalizeFeedUrl', () => {
  it.each([
    ['example.com/feed', 'https://example.com/feed'],
    ['HTTP://Example.COM:80/a?b=1#frag', 'http://example.com/a?b=1'],
    ['https://example.com:443', 'https://example.com/'],
    ['feed://example.com/rss', 'http://example.com/rss'],
    ['feed:https://example.com/rss', 'https://example.com/rss'],
    ['  https://example.com/x  ', 'https://example.com/x'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeFeedUrl(input)).toBe(expected);
  });

  it.each(['ftp://example.com/x', 'javascript:alert(1)', 'http://', 'not a url at all'])(
    'rejects %s',
    (input) => {
      expect(() => normalizeFeedUrl(input)).toThrow(/URL/);
    },
  );
});
