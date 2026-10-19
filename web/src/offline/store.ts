import type { Entry } from '@newses/shared';
import Dexie from 'dexie';
import { ref } from 'vue';
import { bridge, connection, NATIVE } from '../platform/index.ts';
import {
  type Account,
  accountSignedIn,
  accountSignedOut,
  lastAccount,
  markEmptied,
} from './account.ts';
import { afterOthers, type OfflineDb, openOfflineDb } from './db.ts';
import { outboxPending } from './status.ts';
import { setPeriodicSync } from './registration.ts';
import { keepLimits } from './settings.ts';
import { importStaged } from './staged.ts';
import { storeEntries } from './sync.ts';
import { writeWorkerConfig } from './worker-config.ts';

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
  await stopBackground();
  if (account) await Dexie.delete(account.name);
}

/**
 * Stops syncing while the app is closed and drops what that staged, when the store it feeds goes
 * (offline reading off, Clear, sign-out, another account); the next sync starts it again.
 */
async function stopBackground(): Promise<void> {
  try {
    if (NATIVE)
      await bridge.setBackgroundSync({ enabled: false, wifiOnly: false, syncToken: null });
    else {
      await writeWorkerConfig(null);
      await setPeriodicSync(false);
    }
  } catch {
    // Nothing was running.
  }
}

/** Set when another tab took the store over for a newer schema; this page should reload. */
export const storeReplaced = ref(false);

let open: { name: string; db: OfflineDb } | null = null;
/** Set once the app is leaving the active profile; its store stays closed until the reload. */
let left = false;

function closeStore(): void {
  open?.db.close();
  open = null;
}

/** The signed-in account's store while offline reading is on; null otherwise. */
export function currentStore(): OfflineDb | null {
  if (left || !offlineEnabled()) return null;
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
  await stopBackground();
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
    if (previous) await stopBackground();
  }
  await accountSignedIn(account);
}

export async function storeSignedOut(): Promise<void> {
  closeStore();
  await stopBackground();
  await accountSignedOut();
}

/**
 * Leaves the active profile, keeping its store: waits for a sync or send in progress, stores what
 * the Android job fetched for it, and stops background sync; then runs `next` (choosing another
 * profile), after which the app reloads. Nothing syncs into the store in between.
 */
export async function storeLeaving(next: () => Promise<void>): Promise<void> {
  await afterOthers('sync', () =>
    afterOthers('outbox', async () => {
      const db = currentStore();
      left = true;
      if (db && NATIVE) {
        const pages = await bridge.takeBackgroundSync().catch(() => []);
        if (pages.length > 0)
          await importStaged(db, pages, { limits: keepLimits() }).catch(() => undefined);
      }
      closeStore();
      await stopBackground();
      await next();
    }),
  );
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
