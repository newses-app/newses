import type { Category, Counters, Subscription } from '@rss-reader/shared';
import { categoryKey, type StreamKey, subscriptionKey } from './streams.ts';

export interface CategoryNode {
  category: Category;
  key: StreamKey;
  unread: number;
  children: CategoryNode[];
  feeds: FeedNode[];
}

export interface FeedNode {
  subscription: Subscription;
  key: StreamKey;
  unread: number;
}

export interface FeedTree {
  categories: CategoryNode[];
  /** Subscriptions without a category. */
  feeds: FeedNode[];
}

const byOrder =
  <T>(title: (item: T) => string, order: (item: T) => number) =>
  (a: T, b: T) =>
    order(a) - order(b) || title(a).localeCompare(title(b), undefined, { sensitivity: 'base' });

/**
 * Nests categories and subscriptions with their unread counts. With `hideRead`, feeds and
 * categories without unread entries are left out, except `keep` (the open stream).
 */
export function buildTree(
  categories: Category[],
  subscriptions: Subscription[],
  counters: Counters | undefined,
  options: { hideRead?: boolean; keep?: StreamKey | undefined } = {},
): FeedTree {
  const feedUnread = new Map(counters?.subscriptions.map((c) => [c.id, c.unread]));
  const categoryUnread = new Map(counters?.categories.map((c) => [c.id, c.unread]));
  const visible = (key: StreamKey, unread: number) =>
    !options.hideRead || unread > 0 || key === options.keep;

  const feedsByCategory = new Map<number | null, FeedNode[]>();
  for (const subscription of [...subscriptions].sort(
    byOrder<Subscription>(
      (s) => s.title,
      (s) => s.sortOrder,
    ),
  )) {
    const node = {
      subscription,
      key: subscriptionKey(subscription.id),
      unread: feedUnread.get(subscription.id) ?? 0,
    };
    if (!visible(node.key, node.unread)) continue;
    const list = feedsByCategory.get(subscription.categoryId) ?? [];
    list.push(node);
    feedsByCategory.set(subscription.categoryId, list);
  }

  const known = new Set(categories.map((c) => c.id));
  const childrenOf = (parentId: number | null): CategoryNode[] =>
    categories
      .filter(
        (c) => (c.parentId !== null && known.has(c.parentId) ? c.parentId : null) === parentId,
      )
      .sort(
        byOrder<Category>(
          (c) => c.title,
          (c) => c.sortOrder,
        ),
      )
      .map((category) => ({
        category,
        key: categoryKey(category.id),
        unread: categoryUnread.get(category.id) ?? 0,
        children: childrenOf(category.id),
        feeds: feedsByCategory.get(category.id) ?? [],
      }))
      .filter(
        (node) =>
          visible(node.key, node.unread) || node.children.length > 0 || node.feeds.length > 0,
      );

  return { categories: childrenOf(null), feeds: feedsByCategory.get(null) ?? [] };
}

/**
 * Stream keys in tree order, for next/previous feed navigation. Feeds inside collapsed
 * categories are skipped.
 */
export function flattenTree(tree: FeedTree, specialKeys: StreamKey[]): StreamKey[] {
  const keys = [...specialKeys];
  const walk = (node: CategoryNode) => {
    keys.push(node.key);
    if (node.category.collapsed) return;
    node.children.forEach(walk);
    keys.push(...node.feeds.map((f) => f.key));
  };
  tree.categories.forEach(walk);
  keys.push(...tree.feeds.map((f) => f.key));
  return keys;
}
