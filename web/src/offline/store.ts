import type { Entry } from '@newses/shared';
import Dexie from 'dexie';
import { ref } from 'vue';
import { connection, NATIVE } from '../platform/index.ts';
import {
  type Account,
  accountSignedIn,
  accountSignedOut,
  lastAccount,
  markEmptied,
} from './account.ts';
import { type OfflineDb, openOfflineDb } from './db.ts';
import { outboxPending } from './outbox.ts';
import { keepLimits } from './settings.ts';
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

/**
 * Turns offline reading on or off in this browser. Turning it off deletes the stored copy, so a
 * shared computer keeps no one's articles. The apps have it on always.
 */
export async function setOfflineEnabled(enabled: boolean): Promise<void> {
  if (NATIVE) return;
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, 'true');
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // Storage blocked: the browser cannot keep articles either.
  }
  if (enabled) return;
  const account = lastAccount();
  closeStore();
  if (account) await Dexie.delete(account.name);
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

/**
 * Deletes everything kept on this device for the signed-in account, changes not yet sent
 * included; the next sync downloads it again.
 */
export async function clearStore(): Promise<void> {
  const account = lastAccount();
  closeStore();
  if (!account) return;
  await Dexie.delete(account.name);
  // Empty by choice, not evicted by the browser.
  markEmptied();
  outboxPending.value = 0;
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
    await storeEntries(db, entries, Date.now(), keepLimits());
  } catch {
    // Full or blocked storage leaves the store as it was; sync tries again.
  }
}
