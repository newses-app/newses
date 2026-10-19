// Moving between the apps' profiles: each starts the app over, on its own server, token, and store.
import type { Profile } from '@newses/shared';
import { revokeSession } from '../api.ts';
import { accountOf, deleteProfileStore, markEmptied } from '../offline/account.ts';
import { type OfflineDb, openOfflineDb } from '../offline/db.ts';
import { storedBytes } from '../offline/downloads.ts';
import { clearStore, storeLeaving } from '../offline/store.ts';
import { bridge, connection } from './index.ts';
import { forgetProfileKeys } from './profile-keys.ts';

/** Starts the app over at `path`, on the profile now active. */
export function reloadAt(path: string): void {
  history.replaceState(null, '', path);
  location.reload();
}

/** Moves the app to another profile; the one it leaves keeps its session and store. */
export async function switchProfile(id: string, path = '/all'): Promise<void> {
  await storeLeaving(() => bridge.setActiveProfile(id));
  reloadAt(path);
}

/**
 * Moves the app to the server chosen at the connect screen: to its profile, a signed-in one first,
 * or to a new one, named by the server's instance name when it has one, which signs in next.
 */
export async function connectTo(serverUrl: string, name: string | null = null): Promise<void> {
  const known = connection.state.profiles.filter((p) => p.serverUrl === serverUrl);
  let profile = known.find((p) => p.signedIn) ?? known[0];
  if (!profile) {
    profile = await bridge.addProfile(serverUrl);
    if (name) await bridge.updateProfile(profile.id, { label: name });
  }
  await switchProfile(profile.id);
}

/** Reads a profile's store by name, while the app may run on another; null without one. */
async function readStore<T>(
  profile: Profile,
  read: (db: OfflineDb) => Promise<T>,
): Promise<T | null> {
  const account = accountOf(profile.id);
  if (!account) return null;
  const db = openOfflineDb(account.name);
  try {
    return await read(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Changes kept in a profile's store and not yet sent. */
export const pendingChanges = async (profile: Profile): Promise<number> =>
  (await readStore(profile, (db) => db.outbox.count())) ?? 0;

/** What a profile's articles and images take on the device; null without a store. */
export const profileStoredBytes = (profile: Profile): Promise<number | null> =>
  readStore(profile, storedBytes);

/**
 * Deletes what a profile keeps for reading offline, changes not yet sent included; it downloads
 * again when the profile next syncs.
 */
export async function clearProfileStore(profile: Profile): Promise<void> {
  if (profile.id === connection.state.active) {
    await clearStore();
    return;
  }
  await deleteProfileStore(profile.id);
  markEmptied(profile.id);
}

/**
 * Removes a profile, its store, and what else the device kept for it, once `confirm` accepts,
 * told how many changes would be lost; ends its session on the server, when it answers. Removing
 * the active profile moves the app to another, or to the connect screen. Returns whether it was
 * removed.
 */
export async function removeProfile(
  profile: Profile,
  confirm: (pending: number) => Promise<boolean>,
): Promise<boolean> {
  if (!(await confirm(await pendingChanges(profile)))) return false;
  const active = profile.id === connection.state.active;
  const remove = async () => {
    const token = await bridge.removeProfile(profile.id);
    if (token) await revokeSession(profile.serverUrl, token).catch(() => undefined);
    await deleteProfileStore(profile.id);
    forgetProfileKeys(profile.id);
  };
  if (!active) {
    await remove();
    await connection.refresh();
    return true;
  }
  const others = connection.state.profiles.filter((p) => p.id !== profile.id);
  const next = others.find((p) => p.signedIn) ?? others[0];
  await storeLeaving(async () => {
    await remove();
    if (next) await bridge.setActiveProfile(next.id);
  });
  reloadAt('/all');
  return true;
}
