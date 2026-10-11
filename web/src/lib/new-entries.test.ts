import type { Category, Counters, Subscription } from '@rss-reader/shared';
import { describe, expect, it } from 'vitest';
import { newEntries } from './new-entries.ts';

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
