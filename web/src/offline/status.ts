import { ApiError } from '@newses/shared/client';
import { reactive, ref } from 'vue';
import type { OfflineDb } from './db.ts';
import { storedBytes } from './downloads.ts';

const STATUS_KEY = 'syncStatus';

/** How the offline store's syncing goes, for settings; kept in the store across launches. */
export const syncStatus = reactive({
  running: false,
  lastSyncedAt: null as number | null,
  lastError: null as string | null,
  /** The server's API is older than the store needs. */
  unsupported: false,
});

/** Bumped to ask the running sync for one now (settings' Sync now, turning offline on). */
export const syncRequests = ref(0);

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${String(error.status)} ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export async function loadStatus(db: OfflineDb): Promise<void> {
  const saved = (await db.meta.get(STATUS_KEY))?.value as
    { lastSyncedAt: number | null; lastError: string | null } | undefined;
  if (saved) Object.assign(syncStatus, saved);
}

export async function saveStatus(db: OfflineDb): Promise<void> {
  const { lastSyncedAt, lastError } = syncStatus;
  await db.meta.put({ key: STATUS_KEY, value: { lastSyncedAt, lastError } });
}

/** What the store holds, for settings. */
export async function storeSummary(db: OfflineDb) {
  const [entries, contents, images, bytes] = await Promise.all([
    db.entries.count(),
    db.contents.count(),
    db.images.count(),
    storedBytes(db),
  ]);
  return { entries, contents, images, bytes };
}
