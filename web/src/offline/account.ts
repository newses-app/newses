import Dexie from 'dexie';
import type { OfflineDb } from './db.ts';

/** Whose data a store holds: the user, and in the apps the server (null in the browser). */
export interface Account {
  userId: number;
  serverUrl: string | null;
}

interface Remembered extends Account {
  name: string;
  /** Set once the store was filled, so finding it empty later means the browser evicted it. */
  filled?: boolean;
}

const ACCOUNT_KEY = 'newses.offline.account';

/** The database of an account: per user, and in the apps per server too. */
export async function databaseName({ userId, serverUrl }: Account): Promise<string> {
  if (!serverUrl) return `newses-${String(userId)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverUrl));
  const hex = [...new Uint8Array(digest).slice(0, 6)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `newses-${hex}-${String(userId)}`;
}

/** The account last signed in on this device, so the app can start offline with its store. */
export function lastAccount(): Remembered | null {
  try {
    const value = localStorage.getItem(ACCOUNT_KEY);
    return value ? (JSON.parse(value) as Remembered) : null;
  } catch {
    return null;
  }
}

function remember(account: Remembered | null): void {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Storage blocked: the app cannot start offline.
  }
}

/**
 * Records who is signed in. Another user or server deletes the previous account's store, so one
 * device never shows a reader someone else's articles or sends their queued changes.
 */
export async function accountSignedIn(account: Account): Promise<void> {
  const previous = lastAccount();
  if (previous?.userId === account.userId && previous.serverUrl === account.serverUrl) return;
  const name = await databaseName(account);
  if (previous) await Dexie.delete(previous.name);
  remember({ ...account, name });
}

/** Signing out deletes the store, queued changes included; callers confirm that first. */
export async function accountSignedOut(): Promise<void> {
  const previous = lastAccount();
  remember(null);
  if (previous) await Dexie.delete(previous.name);
}

/** Notes that the store holds a sync, for `wasEvicted`. */
export function markFilled(): void {
  const previous = lastAccount();
  if (previous && !previous.filled) remember({ ...previous, filled: true });
}

/** A store that was filled but has no sync token was cleared by the browser (storage pressure, Safari's 7 days). */
export async function wasEvicted(db: OfflineDb): Promise<boolean> {
  if (!lastAccount()?.filled) return false;
  return (await db.meta.get('syncToken')) === undefined;
}
