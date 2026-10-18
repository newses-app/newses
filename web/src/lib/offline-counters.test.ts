import type { Counters } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import { adjustCounters, type CountedEntry } from './offline-counters.ts';
import type { StreamContext } from './offline-streams.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

// Categories 10 > 11; subscription 1 in 11, 2 uncategorised.
const context: StreamContext = {
  categories: [
    { id: 10, parentId: null },
    { id: 11, parentId: 10 },
  ],
  subscriptions: [
    { id: 1, categoryId: 11 },
    { id: 2, categoryId: null },
  ],
  scoreHideBelow: -500,
  freshMaxAgeHours: 24,
  now: NOW,
};

const counters: Counters = {
  subscriptions: [
    { id: 1, unread: 5 },
    { id: 2, unread: 1 },
  ],
  categories: [
    { id: 0, unread: 1 },
    { id: 10, unread: 5 },
    { id: 11, unread: 5 },
  ],
  labels: [{ id: 7, unread: 2 }],
  special: { all: 6, fresh: 3, starred: 1, published: 0 },
};

const entry = (overrides: Partial<CountedEntry> = {}): CountedEntry => ({
  subscriptionId: 1,
  unread: true,
  starred: false,
  published: false,
  score: 0,
  labels: [],
  sortAt: new Date(NOW - 3_600_000).toISOString(),
  ...overrides,
});

describe('adjustCounters', () => {
  it('counts a read entry out of its subscription, categories, labels, and special feeds', () => {
    const before = entry({ starred: true, labels: [7] });
    expect(
      adjustCounters(counters, [{ before, after: { ...before, unread: false } }], context),
    ).toEqual({
      subscriptions: [
        { id: 1, unread: 4 },
        { id: 2, unread: 1 },
      ],
      categories: [
        { id: 0, unread: 1 },
        { id: 10, unread: 4 },
        { id: 11, unread: 4 },
      ],
      labels: [{ id: 7, unread: 1 }],
      special: { all: 5, fresh: 2, starred: 0, published: 0 },
    });
  });

  it('counts hidden scores only in Starred, Published, and labels, and never below zero', () => {
    const before = entry({ subscriptionId: 2, score: -600, published: true, unread: false });
    const after = { ...before, unread: true };
    const out = adjustCounters(counters, [{ before, after }], context);
    expect(out.subscriptions[1]?.unread).toBe(1);
    expect(out.special).toEqual({ all: 6, fresh: 3, starred: 1, published: 1 });
    const read = entry({ subscriptionId: 2, sortAt: '2020-01-01T00:00:00.000Z' });
    const twice = [read, read].map((b) => ({ before: b, after: { ...b, unread: false } }));
    expect(adjustCounters(counters, twice, context).categories[0]?.unread).toBe(0);
  });

  it('follows starring and labelling of unread entries', () => {
    const before = entry();
    const out = adjustCounters(
      counters,
      [{ before, after: { ...before, starred: true, labels: [7] } }],
      context,
    );
    expect(out.special.starred).toBe(2);
    expect(out.labels[0]?.unread).toBe(3);
    expect(out.special.all).toBe(6);
  });

  it('leaves subscriptions hidden from All out of the All and Fresh counts', () => {
    const hiding: StreamContext = {
      ...context,
      subscriptions: [
        { id: 1, categoryId: 11, hideFromAll: true },
        { id: 2, categoryId: null },
      ],
    };
    const before = entry();
    const out = adjustCounters(counters, [{ before, after: { ...before, unread: false } }], hiding);
    expect(out.special).toEqual({ all: 6, fresh: 3, starred: 1, published: 0 });
    expect(out.subscriptions[0]).toEqual({ id: 1, unread: 4 });
  });
});
