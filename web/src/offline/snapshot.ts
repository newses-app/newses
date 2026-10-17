import type { QueryClient } from '@tanstack/vue-query';
import type { OfflineDb } from './db.ts';

/** Queries kept in the store so the app can start offline; each is keyed `[name]`. */
export const SNAPSHOT_QUERIES = [
  'session',
  'prefs',
  'subscriptions',
  'categories',
  'labels',
  'counters',
  'tags',
  'themes',
] as const;

export type SnapshotQuery = (typeof SNAPSHOT_QUERIES)[number];

const SNAPSHOTS: ReadonlySet<unknown> = new Set(SNAPSHOT_QUERIES);

interface Snapshot<T> {
  data: T;
  /** When the data was loaded, so a seeded query counts as stale and reloads once online. */
  at: number;
}

const metaKey = (name: SnapshotQuery) => `query:${name}`;

/** Plain data: query results may hold Vue proxies, which IndexedDB cannot clone. */
const plain = <T>(data: T): T => JSON.parse(JSON.stringify(data)) as T;

export async function writeQuery(
  db: OfflineDb,
  name: SnapshotQuery,
  data: unknown,
  at = Date.now(),
): Promise<void> {
  // The CSRF token belongs to the page's session; a stored copy would be stale.
  const value =
    name === 'session' && data && typeof data === 'object' ? { ...data, csrfToken: null } : data;
  await db.meta.put({ key: metaKey(name), value: { data: plain(value), at } });
}

export async function readQuery<T>(db: OfflineDb, name: SnapshotQuery): Promise<T | undefined> {
  const row = await db.meta.get(metaKey(name));
  return (row?.value as Snapshot<T> | undefined)?.data;
}

/** Copies the snapshot queries' data to the store whenever they load or change. */
export function mirrorQueries(queryClient: QueryClient, store: () => OfflineDb | null): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const key = event.query.queryKey as readonly unknown[];
    const [name, ...rest] = key;
    if (rest.length > 0 || !SNAPSHOTS.has(name)) return;
    const db = store();
    if (!db) return;
    void writeQuery(db, name as SnapshotQuery, event.query.state.data).catch(() => undefined);
  });
}

/** Fills the query cache from the store; false when it holds no session to start from. */
export async function seedQueries(queryClient: QueryClient, db: OfflineDb): Promise<boolean> {
  const rows = await db.meta.bulkGet(SNAPSHOT_QUERIES.map(metaKey));
  if (!rows[0]) return false;
  rows.forEach((row, i) => {
    const name = SNAPSHOT_QUERIES[i];
    if (!row || !name) return;
    const { data, at } = row.value as Snapshot<unknown>;
    queryClient.setQueryData([name], data, { updatedAt: at });
  });
  return true;
}
