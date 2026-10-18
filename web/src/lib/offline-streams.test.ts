import type { Entry, Stream } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import { localPage, type StreamContext } from './offline-streams.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const entry = (id: number, overrides: Partial<Entry> = {}): Entry => ({
  id,
  subscriptionId: 1,
  feedTitle: 'F',
  title: `E${String(id)}`,
  link: null,
  author: null,
  publishedAt: null,
  sortAt: ago(id),
  unread: true,
  starred: false,
  published: false,
  score: 0,
  note: null,
  labels: [],
  tags: [],
  shareId: null,
  readAt: null,
  contentVersion: 'v1',
  excerpt: null,
  ...overrides,
});

// Categories: 10 > 11 > 12, and 20. Subscriptions: 1 in 10, 2 in 12, 3 in 20, 4 uncategorised.
const context: StreamContext = {
  categories: [
    { id: 10, parentId: null },
    { id: 11, parentId: 10 },
    { id: 12, parentId: 11 },
    { id: 20, parentId: null },
  ],
  subscriptions: [
    { id: 1, categoryId: 10 },
    { id: 2, categoryId: 12 },
    { id: 3, categoryId: 20 },
    { id: 4, categoryId: null },
  ],
  scoreHideBelow: -500,
  freshMaxAgeHours: 24,
  now: NOW,
};

const entries = [
  entry(1, { subscriptionId: 1, labels: [7] }),
  entry(2, { subscriptionId: 2, tags: ['cats'] }),
  entry(3, { subscriptionId: 3, unread: false, readAt: ago(2), starred: true }),
  entry(4, { subscriptionId: 4, published: true }),
  entry(30, { subscriptionId: 1 }),
  entry(5, { subscriptionId: 1, score: -600, labels: [7] }),
  entry(6, { subscriptionId: null, unread: false, readAt: ago(24 * 8), starred: true }),
];

const ids = (stream: Stream, view: 'all' | 'unread' = 'all') =>
  localPage(entries, { stream, view, order: 'newest', limit: 50 }, context).entries.map(
    (e) => e.id,
  );

describe('localPage', () => {
  it.each<[string, Stream, number[]]>([
    ['all hides low scores', { special: 'all' }, [1, 2, 3, 4, 6, 30]],
    ['fresh: unread within the window', { special: 'fresh' }, [1, 2, 4]],
    ['starred shows every score', { special: 'starred' }, [3, 6]],
    ['published', { special: 'published' }, [4]],
    ['recently read: within 7 days', { special: 'recentlyRead' }, [3]],
    ['a subscription', { subscriptionId: 1 }, [1, 30]],
    ['a category and its subcategories', { categoryId: 10 }, [1, 2, 30]],
    ['a subcategory alone', { categoryId: 12 }, [2]],
    ['uncategorised', { categoryId: 0 }, [4]],
    ['a label shows every score', { labelId: 7 }, [1, 5]],
    ['a tag', { tag: 'cats' }, [2]],
  ])('%s', (_, stream, expected) => {
    expect(ids(stream)).toEqual(expected);
  });

  it('leaves subscriptions hidden from All out of All and Fresh only', () => {
    const hiding: StreamContext = {
      ...context,
      subscriptions: context.subscriptions.map((s) => ({ ...s, hideFromAll: s.id === 1 })),
    };
    const shown = (stream: Stream) =>
      localPage(entries, { stream, view: 'all', order: 'newest', limit: 50 }, hiding).entries.map(
        (e) => e.id,
      );
    expect(shown({ special: 'all' })).toEqual([2, 3, 4, 6]);
    expect(shown({})).toEqual([2, 3, 4, 6]);
    expect(shown({ special: 'fresh' })).toEqual([2, 4]);
    expect(shown({ subscriptionId: 1 })).toEqual([1, 30]);
    expect(shown({ categoryId: 10 })).toEqual([1, 2, 30]);
  });

  it('lists only unread entries in the unread view, and resolves adaptive', () => {
    expect(ids({ special: 'all' }, 'unread')).toEqual([1, 2, 4, 30]);
    const adaptive = (stream: Stream) =>
      localPage(entries, { stream, view: 'adaptive', order: 'newest', limit: 50 }, context);
    expect(adaptive({ special: 'all' }).view).toBe('unread');
    expect(adaptive({ special: 'starred' }).view).toBe('all');
  });

  it('orders oldest first, by title, and recently read by reading time', () => {
    const order = (o: 'oldest' | 'title', stream: Stream = { subscriptionId: 1 }) =>
      localPage(entries, { stream, view: 'all', order: o, limit: 50 }, context).entries.map(
        (e) => e.id,
      );
    expect(order('oldest')).toEqual([30, 1]);
    const titled = [entry(1, { title: 'b' }), entry(2, { title: 'A' }), entry(3, { title: null })];
    expect(
      localPage(titled, { stream: {}, view: 'all', order: 'title', limit: 9 }, context).entries.map(
        (e) => e.id,
      ),
    ).toEqual([3, 2, 1]);
    const read = [
      entry(1, { unread: false, readAt: ago(5) }),
      entry(2, { unread: false, readAt: ago(1) }),
    ];
    expect(
      localPage(
        read,
        { stream: { special: 'recentlyRead' }, view: 'all', order: 'newest', limit: 9 },
        context,
      ).entries.map((e) => e.id),
    ).toEqual([2, 1]);
  });

  it('pages by offset, and has nothing after a cursor from the server', () => {
    const first = localPage(
      entries,
      { stream: {}, view: 'all', order: 'newest', limit: 4 },
      context,
    );
    expect(first.entries.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    const second = localPage(
      entries,
      { stream: {}, view: 'all', order: 'newest', limit: 4, cursor: first.cursor ?? '' },
      context,
    );
    expect(second).toMatchObject({ cursor: null });
    expect(second.entries.map((e) => e.id)).toEqual([6, 30]);
    expect(
      localPage(
        entries,
        { stream: {}, view: 'all', order: 'newest', limit: 4, cursor: 'eyJ2Ijo' },
        context,
      ).entries,
    ).toEqual([]);
  });
});
