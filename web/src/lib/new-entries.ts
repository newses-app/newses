import type { Category, Counters, Subscription } from '@newses/shared';
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

export interface AwayNotifier {
  /** A counters reading while the reader is away, with the reading before it. */
  reading(before: Counters, next: Counters): void;
  /** The reader is back: the next time away starts again. */
  back(): void;
}

/**
 * One running total of new entries while the reader is away, counted from the reading before they
 * left: the first shows at once, later ones at most every `gapMs` with the latest total, and only
 * when it has grown.
 */
export function awayNotifier(options: {
  find: (since: Counters, latest: Counters) => NewEntries | null;
  show: (found: NewEntries) => void;
  gapMs: number;
}): AwayNotifier {
  let since: Counters | null = null;
  let latest: Counters | null = null;
  let shownCount = 0;
  let shownAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const found = since && latest && options.find(since, latest);
    if (!found || found.count <= shownCount) return;
    shownCount = found.count;
    shownAt = Date.now();
    options.show(found);
  };
  return {
    reading(before, next) {
      since ??= before;
      latest = next;
      if (timer !== undefined) return;
      const wait = shownAt === null ? 0 : shownAt + options.gapMs - Date.now();
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    back() {
      clearTimeout(timer);
      timer = undefined;
      since = null;
      latest = null;
      shownCount = 0;
      shownAt = null;
    },
  };
}
