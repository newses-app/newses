import type { Counters, Entry } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import {
  adjacentStream,
  archiveStream,
  readerPanes,
  readerTitle,
  stepIndex,
  streamTitle,
  streamUnread,
  toggledState,
} from './reader-view.ts';
import { parseStream } from './streams.ts';

const counters: Counters = {
  subscriptions: [{ id: 1, unread: 4 }],
  categories: [{ id: 2, unread: 7 }],
  labels: [{ id: 3, unread: 2 }],
  special: { all: 11, fresh: 5, starred: 1, published: 0 },
};

describe('streamUnread', () => {
  it('counts each kind of stream from the counters', () => {
    expect(streamUnread(counters, parseStream('all'))).toBe(11);
    expect(streamUnread(counters, parseStream('f1'))).toBe(4);
    expect(streamUnread(counters, parseStream('c2'))).toBe(7);
    expect(streamUnread(counters, parseStream('l3'))).toBe(2);
  });

  it('is 0 for unknown streams, recently read, tags, and before the counters arrive', () => {
    expect(streamUnread(counters, parseStream('f9'))).toBe(0);
    expect(streamUnread(counters, parseStream('c9'))).toBe(0);
    expect(streamUnread(counters, parseStream('l9'))).toBe(0);
    expect(streamUnread(counters, parseStream('read'))).toBe(0);
    expect(streamUnread(counters, parseStream('tnews'))).toBe(0);
    expect(streamUnread(undefined, parseStream('all'))).toBe(0);
  });
});

describe('streamTitle', () => {
  const t = (key: string, params?: Record<string, string>) =>
    params ? `${key} ${JSON.stringify(params)}` : key;
  const data = {
    subscription: undefined,
    labels: [{ id: 3, caption: 'Later' }],
    categories: [{ id: 2, title: 'News' }],
  };
  const title = (key: string, extra: Partial<Parameters<typeof streamTitle>[2]> = {}) =>
    streamTitle(key, parseStream(key), { ...data, ...extra }, t);

  it('names special feeds, tags, labels, feeds, and categories', () => {
    expect(title('all')).toBe('special.all');
    expect(title('tnews')).toBe('tags.stream {"tag":"news"}');
    expect(title('l3')).toBe('Later');
    expect(title('f1', { subscription: { title: 'Blog' } })).toBe('Blog');
    expect(title('c0')).toBe('tree.uncategorised');
    expect(title('c2')).toBe('News');
  });

  it('is empty until the label, feed, or category is known', () => {
    expect(title('l9')).toBe('');
    expect(title('f1')).toBe('');
    expect(title('c2', { categories: undefined })).toBe('');
    expect(title('l3', { labels: undefined })).toBe('');
  });
});

describe('archiveStream', () => {
  it("browses the feed's archive, or every feed's from All articles", () => {
    expect(archiveStream('f4', { id: 4 })).toBe('f4');
    expect(archiveStream('all', undefined)).toBe('all');
    expect(archiveStream('c2', undefined)).toBeNull();
  });
});

describe('stepIndex', () => {
  const ids = [10, 20, 30];

  it('moves to the next or previous article', () => {
    expect(stepIndex(ids, 20, 1)).toBe(2);
    expect(stepIndex(ids, 20, -1)).toBe(0);
    expect(stepIndex(ids, 30, 1)).toBe(3);
  });

  it('starts at the first going forward, and the last going back, with none open', () => {
    expect(stepIndex(ids, null, 1)).toBe(0);
    expect(stepIndex(ids, null, -1)).toBe(-1);
    expect(stepIndex(ids, 99, 1)).toBe(0);
  });
});

describe('adjacentStream', () => {
  it('moves along the feed list, and stops at its ends', () => {
    const keys = ['all', 'fresh', 'f1', 'c2'];
    expect(adjacentStream(keys, 'fresh', 1)).toBe('f1');
    expect(adjacentStream(keys, 'fresh', -1)).toBe('all');
    expect(adjacentStream(keys, 'c2', 1)).toBeUndefined();
    expect(adjacentStream(keys, 'all', -1)).toBeUndefined();
  });
});

describe('readerPanes', () => {
  it('shows both panes when wide, and one at a time when narrow', () => {
    expect(readerPanes({ singlePane: false, combined: false, open: true })).toEqual({
      list: true,
      article: true,
    });
    expect(readerPanes({ singlePane: true, combined: false, open: false })).toEqual({
      list: true,
      article: false,
    });
    expect(readerPanes({ singlePane: true, combined: false, open: true })).toEqual({
      list: false,
      article: true,
    });
  });

  it('shows only the list in the combined layout', () => {
    for (const singlePane of [true, false])
      expect(readerPanes({ singlePane, combined: true, open: true })).toEqual({
        list: true,
        article: false,
      });
  });
});

describe('toggledState', () => {
  const entry = { starred: false, published: true, unread: true } as Entry;

  it('flips the flag the shortcut toggles', () => {
    expect(toggledState('toggleStar', entry)).toEqual({ starred: true });
    expect(toggledState('togglePublished', entry)).toEqual({ published: false });
    expect(toggledState('toggleUnread', entry)).toEqual({ unread: false });
    expect(toggledState('nextArticle', entry)).toBeNull();
  });
});

describe('readerTitle', () => {
  it("leads with the open article's title", () => {
    expect(readerTitle('News', 'Big story')).toBe('Big story – News');
    expect(readerTitle('News', null)).toBe('News');
    expect(readerTitle('News', '')).toBe('News');
  });
});
