import type { Category, Counters, Subscription } from '@rss-reader/shared';
import { categoryKey, streamPath, type StreamKey, subscriptionKey } from './streams.ts';

/** What one notification says: how many new entries, where, and which stream a click opens. */
export interface NewEntries {
  count: number;
  /** Categories (or uncategorised feeds) with new entries, most first. */
  places: string[];
  target: string;
}

/**
 * New unread entries between two counter readings, by subscription. Subscriptions missing from the
 * earlier reading are new and not counted, so subscribing never notifies.
 */
export function newEntries(
  before: Counters,
  after: Counters,
  subscriptions: readonly Subscription[],
  categories: readonly Category[],
): NewEntries | null {
  const earlier = new Map(before.subscriptions.map((s) => [s.id, s.unread]));
  const byId = new Map(subscriptions.map((s) => [s.id, s]));
  const titles = new Map(categories.map((c) => [c.id, c.title]));
  const places = new Map<string, number>();
  const feeds = new Set<number>();
  const groups = new Set<number | null>();
  let count = 0;
  for (const { id, unread } of after.subscriptions) {
    const previous = earlier.get(id);
    const subscription = byId.get(id);
    if (previous === undefined || unread <= previous || !subscription) continue;
    const added = unread - previous;
    count += added;
    feeds.add(id);
    groups.add(subscription.categoryId);
    const place =
      subscription.categoryId === null
        ? subscription.title
        : (titles.get(subscription.categoryId) ?? subscription.title);
    places.set(place, (places.get(place) ?? 0) + added);
  }
  if (count === 0) return null;

  const [feed] = feeds;
  const [group] = groups;
  // One feed, else one category (`c0`: uncategorised), else everything.
  let key: StreamKey = 'all';
  if (feeds.size === 1 && feed !== undefined) key = subscriptionKey(feed);
  else if (groups.size === 1 && group !== undefined) key = categoryKey(group ?? 0);
  return {
    count,
    places: [...places].sort((a, b) => b[1] - a[1]).map(([place]) => place),
    target: streamPath(key),
  };
}
