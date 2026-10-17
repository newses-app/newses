import type { Entry } from '@newses/shared';

/** What the local store keeps; past the counts, the oldest go first. */
export interface KeepLimits {
  unread: number;
  starred: number;
  /** Read entries stay this many days after they were read. */
  readDays: number;
  read: number;
}

export const DEFAULT_KEEP: KeepLimits = { unread: 5000, starred: 2000, readDays: 7, read: 2000 };

const DAY_MS = 86_400_000;

/** The time before which read entries leave the store, as the API writes `readAt`. */
export const readCutoff = (now: number, limits: KeepLimits) =>
  new Date(now - limits.readDays * DAY_MS).toISOString();

/** Whether an entry belongs in the store: unread, starred, or read recently. */
export const keeps = (
  entry: Pick<Entry, 'unread' | 'starred' | 'readAt'>,
  now: number,
  limits: KeepLimits = DEFAULT_KEEP,
) =>
  entry.unread ||
  entry.starred ||
  (entry.readAt !== null && entry.readAt >= readCutoff(now, limits));

/** `list` with `changed` rows replaced or added by id, and `deleted` ids removed. */
export function upsertById<T extends { id: number }>(
  list: readonly T[],
  changed: readonly T[],
  deleted: readonly number[] = [],
): T[] {
  const updates = new Map(changed.map((row) => [row.id, row]));
  const gone = new Set(deleted);
  const kept = list
    .filter((row) => !gone.has(row.id))
    .map((row) => {
      const update = updates.get(row.id);
      updates.delete(row.id);
      return update ?? row;
    });
  return [...kept, ...[...updates.values()].filter((row) => !gone.has(row.id))];
}
