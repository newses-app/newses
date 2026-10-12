import type { Category, Counters, Subscription } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import { buildTree, flattenTree } from './tree.ts';

const category = (
  id: number,
  title: string,
  parentId: number | null = null,
  collapsed = false,
): Category => ({
  id,
  title,
  parentId,
  sortOrder: 0,
  collapsed,
});
const feed = (
  id: number,
  title: string,
  categoryId: number | null,
  sortOrder = 0,
): Subscription => ({
  id,
  feedSourceId: id,
  title,
  customTitle: null,
  url: `https://f${String(id)}.example/rss`,
  siteUrl: null,
  categoryId,
  sortOrder,
  iconUrl: null,
  lastFetchedAt: null,
  lastError: null,
  lastErrorAt: null,
  errorCount: 0,
  disabled: false,
  updateIntervalMinutes: null,
  purgeDays: null,
  fullText: false,
});
const counters: Counters = {
  subscriptions: [
    { id: 1, unread: 3 },
    { id: 2, unread: 0 },
    { id: 3, unread: 1 },
  ],
  categories: [
    { id: 10, unread: 3 },
    { id: 11, unread: 0 },
    { id: 0, unread: 1 },
  ],
  labels: [],
  special: { all: 4, fresh: 0, starred: 0, published: 0 },
};

describe('buildTree', () => {
  const categories = [category(10, 'News'), category(11, 'Sub', 10)];
  const subscriptions = [feed(2, 'beta', 11), feed(1, 'Alpha', 10), feed(3, 'Loose', null)];

  it('nests categories and feeds with counts, ordered by sort order then title', () => {
    const tree = buildTree(categories, subscriptions, counters);
    expect(tree.categories.map((c) => [c.key, c.unread])).toEqual([['c10', 3]]);
    expect(tree.categories[0]?.children.map((c) => c.key)).toEqual(['c11']);
    expect(tree.categories[0]?.children[0]?.feeds.map((f) => f.key)).toEqual(['f2']);
    expect(tree.feeds.map((f) => [f.key, f.unread])).toEqual([['f3', 1]]);
    const ordered = buildTree(
      [],
      [feed(1, 'b', null, 1), feed(2, 'a', null, 1), feed(3, 'z', null, 0)],
      undefined,
    );
    expect(ordered.feeds.map((f) => f.subscription.title)).toEqual(['z', 'a', 'b']);
  });

  it('hides read feeds and empty categories, except the open stream', () => {
    const hidden = buildTree(categories, subscriptions, counters, { hideRead: true });
    expect(hidden.categories[0]?.children).toEqual([]);
    const kept = buildTree(categories, subscriptions, counters, { hideRead: true, keep: 'f2' });
    expect(kept.categories[0]?.children[0]?.feeds.map((f) => f.key)).toEqual(['f2']);
  });

  it('flattens in tree order, skipping collapsed categories', () => {
    const tree = buildTree(categories, subscriptions, counters);
    expect(flattenTree(tree, ['all'])).toEqual(['all', 'c10', 'c11', 'f2', 'f1', 'f3']);
    const collapsed = buildTree(
      [category(10, 'News', null, true), ...categories.slice(1)],
      subscriptions,
      counters,
    );
    expect(flattenTree(collapsed, [])).toEqual(['c10', 'f3']);
  });
});
