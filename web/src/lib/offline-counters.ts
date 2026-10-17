import type { Counters, Entry } from '@newses/shared';
import type { StreamContext } from './offline-streams.ts';

/** What counting an entry needs: its flags, place, score, and age. */
export type CountedEntry = Pick<
  Entry,
  'subscriptionId' | 'unread' | 'starred' | 'published' | 'score' | 'labels' | 'sortAt'
>;

/** An entry before and after a change made on this device. */
export interface CounterChange {
  before: CountedEntry;
  after: CountedEntry;
}

const HOUR_MS = 3_600_000;

type Tally = Map<string, number>;

/** Adds what one unread entry counts toward, as the server counts it, times `sign`. */
function tally(
  into: Tally,
  entry: CountedEntry,
  sign: 1 | -1,
  context: StreamContext,
  parents: ReadonlyMap<number, number | null>,
  categoryOf: ReadonlyMap<number, number | null>,
): void {
  if (!entry.unread) return;
  const add = (key: string) => into.set(key, (into.get(key) ?? 0) + sign);
  // Entries hidden by their score count only where they are listed: Starred, Published, labels.
  if (entry.score >= context.scoreHideBelow) {
    add('all');
    const since = new Date(context.now - context.freshMaxAgeHours * HOUR_MS).toISOString();
    if (entry.sortAt > since) add('fresh');
    if (entry.subscriptionId !== null) {
      add(`s${String(entry.subscriptionId)}`);
      const categoryId = categoryOf.get(entry.subscriptionId);
      if (categoryId === undefined) {
        // A subscription the snapshot does not know: count it nowhere else.
      } else if (categoryId === null) add('c0');
      else {
        const seen = new Set<number>();
        for (let id: number | null | undefined = categoryId; id != null && !seen.has(id);) {
          seen.add(id);
          add(`c${String(id)}`);
          id = parents.get(id);
        }
      }
    }
  }
  if (entry.starred) add('starred');
  if (entry.published) add('published');
  for (const label of entry.labels) add(`l${String(label)}`);
}

/**
 * The server's last counters with changes made on this device applied, as the server would count
 * them once it has the changes. Counts never go below zero.
 */
export function adjustCounters(
  counters: Counters,
  changes: readonly CounterChange[],
  context: StreamContext,
): Counters {
  const parents = new Map(context.categories.map((c) => [c.id, c.parentId]));
  const categoryOf = new Map(context.subscriptions.map((s) => [s.id, s.categoryId]));
  const delta: Tally = new Map();
  for (const { before, after } of changes) {
    tally(delta, before, -1, context, parents, categoryOf);
    tally(delta, after, 1, context, parents, categoryOf);
  }
  if ([...delta.values()].every((d) => d === 0)) return counters;
  const shift = (key: string, unread: number) => Math.max(0, unread + (delta.get(key) ?? 0));
  const rows = (prefix: string, list: Counters['subscriptions']) =>
    list.map((row) => ({ ...row, unread: shift(`${prefix}${String(row.id)}`, row.unread) }));
  return {
    subscriptions: rows('s', counters.subscriptions),
    categories: rows('c', counters.categories),
    labels: rows('l', counters.labels),
    special: {
      all: shift('all', counters.special.all),
      fresh: shift('fresh', counters.special.fresh),
      starred: shift('starred', counters.special.starred),
      published: shift('published', counters.special.published),
    },
  };
}
