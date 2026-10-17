import type { Entry } from '@newses/shared';
import { ref } from 'vue';
import { DEFAULT_KEEP } from '../lib/offline-keep.ts';
import { connection, NATIVE } from '../platform/index.ts';
import { type Account, accountSignedIn, accountSignedOut, lastAccount } from './account.ts';
import { type OfflineDb, openOfflineDb } from './db.ts';
import { storeEntries } from './sync.ts';

const ENABLED_KEY = 'newses.offline.enabled';

/** On in the apps; in a browser, which may be shared, only once turned on for this device. */
export function offlineEnabled(): boolean {
  if (NATIVE) return true;
  try {
    return localStorage.getItem(ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Set when another tab took the store over for a newer schema; this page should reload. */
export const storeReplaced = ref(false);

let open: { name: string; db: OfflineDb } | null = null;

function closeStore(): void {
  open?.db.close();
  open = null;
}

/** The signed-in account's store while offline reading is on; null otherwise. */
export function currentStore(): OfflineDb | null {
  if (!offlineEnabled()) return null;
  const account = lastAccount();
  if (!account || account.serverUrl !== connection.state.serverUrl) return null;
  if (open?.name !== account.name) {
    closeStore();
    const db = openOfflineDb(account.name, () => {
      if (open?.db === db) open = null;
      storeReplaced.value = true;
    });
    open = { name: account.name, db };
  }
  return open.db;
}

export async function storeSignedIn(account: Account): Promise<void> {
  const previous = lastAccount();
  if (previous?.userId !== account.userId || previous.serverUrl !== account.serverUrl) {
    closeStore();
  }
  await accountSignedIn(account);
}

export async function storeSignedOut(): Promise<void> {
  closeStore();
  await accountSignedOut();
}

/** Keeps entries loaded online in the store too, so it is as fresh as what was last seen. */
export async function keepLoaded(entries: readonly Entry[]): Promise<void> {
  const db = currentStore();
  if (!db || entries.length === 0) return;
  try {
    await storeEntries(db, entries, Date.now(), DEFAULT_KEEP);
  } catch {
    // Full or blocked storage leaves the store as it was; sync tries again.
  }
}
