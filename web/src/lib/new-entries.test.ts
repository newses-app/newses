import type { Category, Counters, Subscription } from '@newses/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awayNotifier,
  type NewEntries,
  newEntries,
  newEntriesHandover,
  notificationStrings,
} from './new-entries.ts';

const counters = (unread: Record<number, number>): Counters => ({
  subscriptions: Object.entries(unread).map(([id, count]) => ({ id: Number(id), unread: count })),
  categories: [],
  labels: [],
  special: { all: 0, fresh: 0, starred: 0, published: 0 },
});
const subscription = (id: number, title: string, categoryId: number | null) =>
  ({ id, title, categoryId }) as Subscription;
const category = (id: number, title: string) => ({ id, title }) as Category;

const subscriptions = [
  subscription(1, 'Ars', 10),
  subscription(2, 'Verge', 10),
  subscription(3, 'BBC', 20),
  subscription(4, 'Blog', null),
  subscription(5, 'Other blog', null),
];
const categories = [category(10, 'Tech'), category(20, 'News')];

describe('newEntries', () => {
  it('sums new unread entries and names categories, most first', () => {
    expect(
      newEntries(
        counters({ 1: 0, 2: 5, 3: 0 }),
        counters({ 1: 2, 2: 6, 3: 4 }),
        subscriptions,
        categories,
      ),
    ).toEqual({ count: 7, places: ['News', 'Tech'], target: '/all' });
  });

  it('opens the one feed or category the new entries are in', () => {
    expect(newEntries(counters({ 1: 0 }), counters({ 1: 3 }), subscriptions, categories)).toEqual({
      count: 3,
      places: ['Tech'],
      target: '/f1',
    });
    expect(
      newEntries(counters({ 1: 0, 2: 0 }), counters({ 1: 1, 2: 1 }), subscriptions, categories)
        ?.target,
    ).toBe('/c10');
    expect(
      newEntries(counters({ 4: 0, 5: 0 }), counters({ 4: 1, 5: 2 }), subscriptions, categories),
    ).toEqual({ count: 3, places: ['Other blog', 'Blog'], target: '/c0' });
  });

  it('ignores reading, and feeds that were just subscribed', () => {
    expect(
      newEntries(counters({ 1: 5 }), counters({ 1: 2 }), subscriptions, categories),
    ).toBeNull();
    expect(newEntries(counters({}), counters({ 1: 40 }), subscriptions, categories)).toBeNull();
  });
});

describe('awayNotifier', () => {
  const GAP = 15 * 60_000;
  let shown: number[];
  const notifier = () =>
    awayNotifier({
      find: (since, latest) => newEntries(since, latest, subscriptions, categories),
      show: (found: NewEntries) => shown.push(found.count),
      gapMs: GAP,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the first rise at once, then the running total at most every gap', () => {
    const away = notifier();
    away.reading(counters({ 1: 0 }), counters({ 1: 2 }));
    expect(shown).toEqual([2]);
    away.reading(counters({ 1: 2 }), counters({ 1: 3 }));
    away.reading(counters({ 1: 3 }), counters({ 1: 7 }));
    vi.advanceTimersByTime(GAP - 1);
    expect(shown).toEqual([2]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual([2, 7]);
    // Nothing more since: nothing shows again.
    away.reading(counters({ 1: 7 }), counters({ 1: 7 }));
    vi.advanceTimersByTime(GAP);
    expect(shown).toEqual([2, 7]);
  });

  it('starts again, at once, when the reader comes back and leaves', () => {
    const away = notifier();
    away.reading(counters({ 1: 0 }), counters({ 1: 2 }));
    away.reading(counters({ 1: 2 }), counters({ 1: 3 }));
    away.back();
    vi.advanceTimersByTime(GAP);
    expect(shown).toEqual([2]);
    away.reading(counters({ 1: 3 }), counters({ 1: 4 }));
    expect(shown).toEqual([2, 1]);
  });
});

describe('notificationStrings', () => {
  // As the app's `t()`: parameters isolated, and the plural choice picking the form.
  const isolated = (text: string | undefined) => `\u2068${text ?? ''}\u2069`;
  const messages: Record<string, (p: Record<string, string>, plural?: number) => string> = {
    'notifications.title': (p, plural) =>
      plural === 1 ? `${isolated(p.n)} nuevo` : `${isolated(p.n)} nuevos`,
    'notifications.more': (p) => `${isolated(p.places)} y ${isolated(p.n)} más`,
    'notifications.channel': () => 'Artículos nuevos',
  };
  const t = (key: string, params: Record<string, string>, plural?: number) =>
    messages[key]?.(params, plural) ?? key;

  it('gives each plural form with placeholders, without isolates', () => {
    expect(notificationStrings(t, 'es', ['one', 'other'])).toMatchObject({
      locale: 'es',
      title: { one: '{n} nuevo', other: '{n} nuevos' },
      more: '{places} y {n} más',
      channel: 'Artículos nuevos',
    });
  });

  it('lists places as the desktop does', () => {
    expect(notificationStrings(t, 'en', ['one', 'other']).lists).toEqual([
      '{0}',
      '{0}, {1}',
      '{0}, {1}, {2}',
    ]);
  });
});

describe('newEntriesHandover', () => {
  it('gives the marks and where each subscription is', () => {
    const strings = notificationStrings(() => '', 'en', ['other']);
    expect(newEntriesHandover(strings, 900, subscriptions, categories)).toEqual({
      strings,
      entryMark: 900,
      subscriptionMark: 5,
      subscriptions: [
        [1, 10, 'Ars'],
        [2, 10, 'Verge'],
        [3, 20, 'BBC'],
        [4, null, 'Blog'],
        [5, null, 'Other blog'],
      ],
      categories: [
        [10, 'Tech'],
        [20, 'News'],
      ],
    });
  });

  it('marks no subscriptions before they have loaded', () => {
    expect(
      newEntriesHandover(
        notificationStrings(() => '', 'en', []),
        0,
        [],
        [],
      ).subscriptionMark,
    ).toBe(0);
  });
});
