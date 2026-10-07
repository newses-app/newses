import { describe, expect, it } from 'vitest';
import {
  categoryKey,
  labelKey,
  parseStream,
  STREAM_PATTERN,
  streamPath,
  subscriptionKey,
  tagKey,
} from './streams.ts';

describe('stream keys', () => {
  it('round-trips special feeds, subscriptions, categories, labels, and tags', () => {
    expect(parseStream('all')).toEqual({ special: 'all' });
    expect(parseStream('read')).toEqual({ special: 'recentlyRead' });
    expect(parseStream(subscriptionKey(12))).toEqual({ subscriptionId: 12 });
    expect(parseStream(categoryKey(0))).toEqual({ categoryId: 0 });
    expect(parseStream(labelKey(7))).toEqual({ labelId: 7 });
    expect(parseStream(tagKey('open source'))).toEqual({ tag: 'open source' });
    expect(parseStream(tagKey('a/b%c'))).toEqual({ tag: 'a/b%c' });
    expect(parseStream('nonsense')).toEqual({ special: 'all' });
  });

  it('matches every key in the route pattern and nothing else', () => {
    const pattern = new RegExp(`^(${STREAM_PATTERN})$`);
    for (const key of [
      'all',
      'fresh',
      'starred',
      'published',
      'read',
      'f3',
      'c0',
      'l7',
      'tgo',
      streamPath(tagKey('a/b c')).slice(1),
    ])
      expect(pattern.test(key)).toBe(true);
    for (const key of ['settings', 'f', 'cx', 'l', 't', 'ta/b', 'login'])
      expect(pattern.test(key)).toBe(false);
  });
});
