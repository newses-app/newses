import type {
  Category,
  Counters,
  NewEntriesHandover,
  NotificationStrings,
  PushMessage,
  Subscription,
} from '@newses/shared';
import { LOCALES } from '@newses/shared/locales';
import { formatList } from './format.ts';
import { withoutIsolates } from './message-params.ts';
import { categoryKey, streamPath, type StreamKey, subscriptionKey } from './streams.ts';

/** Places named in a notification before "and N more". */
export const PLACES = 3;

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

/** `t()` with a plural choice. */
type Translate = (key: string, params: Record<string, string>, plural?: number) => string;

/** Counts tried for an example of each plural form. */
const SAMPLES = Array.from({ length: 201 }, (_, n) => n);

/**
 * The notification's messages for the Android job and the service worker, which word it while the
 * app is closed: the
 * title for each plural form the language's messages have (`plurals`), lists of one to `PLACES`
 * places, and the "and N more" form, with placeholders for what it fills in.
 */
export function notificationStrings(
  t: Translate,
  locale: string,
  plurals: readonly string[],
): NotificationStrings {
  const rules = new Intl.PluralRules(locale);
  const title: Record<string, string> = {};
  for (const form of plurals) {
    const sample = SAMPLES.find((n) => rules.select(n) === form);
    if (sample !== undefined)
      title[form] = withoutIsolates(t('notifications.title', { n: '{n}' }, sample));
  }
  const places = Array.from({ length: PLACES }, (_, i) => `{${String(i)}}`);
  return {
    locale,
    title,
    lists: places.map((_, i) => formatList(places.slice(0, i + 1), locale)),
    more: withoutIsolates(t('notifications.more', { places: '{places}', n: '{n}' })),
    channel: t('notifications.channel', {}),
  };
}

/** `notificationStrings` for one of the app's languages, with the plural forms its messages have. */
export const appNotificationStrings = (t: Translate, locale: string): NotificationStrings =>
  notificationStrings(
    t,
    locale,
    LOCALES.find((l) => l.code === locale)?.plurals ?? ['one', 'other'],
  );

/** What the Android job needs to count new entries against the store and say where they are. */
export function newEntriesHandover(
  strings: NotificationStrings,
  entryMark: number,
  subscriptions: readonly Subscription[],
  categories: readonly Category[],
): NewEntriesHandover {
  return {
    strings,
    entryMark,
    subscriptionMark: Math.max(0, ...subscriptions.map((s) => s.id)),
    subscriptions: subscriptions.map((s) => [s.id, s.categoryId, s.title]),
    categories: categories.map((c) => [c.id, c.title]),
  };
}

/** Fills `{name}` placeholders in one pass, so placeholders inside the values are never read. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** A push message's notification, worded with the messages the app handed over. */
export function pushNotificationText(
  strings: NotificationStrings,
  message: PushMessage,
): { title: string; body: string } {
  const numbers = new Intl.NumberFormat(strings.locale);
  const form = new Intl.PluralRules(strings.locale).select(message.count);
  const title = fillTemplate(strings.title[form] ?? strings.title.other ?? '{n}', {
    n: numbers.format(message.count),
  });
  const names = message.places.slice(0, PLACES).map((place) => place.title);
  const list =
    names.length > 0
      ? fillTemplate(
          strings.lists[names.length - 1] ?? names.join(', '),
          Object.fromEntries(names.map((name, i) => [String(i), name])),
        )
      : '';
  const more = message.places.length - names.length + message.morePlaces;
  return {
    title,
    body: more > 0 ? fillTemplate(strings.more, { places: list, n: numbers.format(more) }) : list,
  };
}

/** Streams a push message may open. */
const PUSH_TARGET = /^\/(all|[fc]\d+)$/;

/** `data` when it is a push message of new entries, else null. */
export function asPushMessage(data: unknown): PushMessage | null {
  const message = data as Partial<PushMessage> | null;
  if (
    message?.type !== 'new-entries' ||
    typeof message.count !== 'number' ||
    !Array.isArray(message.places) ||
    typeof message.morePlaces !== 'number' ||
    typeof message.target !== 'string' ||
    !PUSH_TARGET.test(message.target)
  )
    return null;
  const places = message.places.filter(
    (place) => typeof place.title === 'string' && typeof place.count === 'number',
  );
  return { ...(message as PushMessage), places };
}

/**
 * The running total of a notification still showing and a new message: places added up, the
 * stream both opened, else everything.
 */
export function mergePushMessages(shown: PushMessage, next: PushMessage): PushMessage {
  const counts = new Map(shown.places.map((place) => [place.title, place.count]));
  for (const place of next.places)
    counts.set(place.title, (counts.get(place.title) ?? 0) + place.count);
  return {
    type: 'new-entries',
    count: shown.count + next.count,
    places: [...counts]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
    morePlaces: Math.max(shown.morePlaces, next.morePlaces),
    target: shown.target === next.target ? next.target : '/all',
  };
}
