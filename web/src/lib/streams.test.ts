import { describe, expect, it } from 'vitest';
import { categoryKey, parseStream, STREAM_PATTERN, subscriptionKey } from './streams.ts';

describe('stream keys', () => {
  it('round-trips special feeds, subscriptions, and categories', () => {
    expect(parseStream('all')).toEqual({ special: 'all' });
    expect(parseStream('read')).toEqual({ special: 'recentlyRead' });
    expect(parseStream(subscriptionKey(12))).toEqual({ subscriptionId: 12 });
    expect(parseStream(categoryKey(0))).toEqual({ categoryId: 0 });
    expect(parseStream('nonsense')).toEqual({ special: 'all' });
  });

  it('matches every key in the route pattern and nothing else', () => {
    const pattern = new RegExp(`^(${STREAM_PATTERN})$`);
    for (const key of ['all', 'fresh', 'starred', 'published', 'read', 'f3', 'c0'])
      expect(pattern.test(key)).toBe(true);
    for (const key of ['settings', 'f', 'cx', 'login']) expect(pattern.test(key)).toBe(false);
  });
});
