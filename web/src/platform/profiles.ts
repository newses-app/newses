// Moving between the apps' profiles: each starts the app over, on its own server, token, and store.
import type { Profile } from '@newses/shared';
import { revokeSession } from '../api.ts';
import { accountOf, deleteProfileStore } from '../offline/account.ts';
import { openOfflineDb } from '../offline/db.ts';
import { storeLeaving } from '../offline/store.ts';
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
 * or to a new one, which signs in next.
 */
export async function connectTo(serverUrl: string): Promise<void> {
  const known = connection.state.profiles.filter((p) => p.serverUrl === serverUrl);
  const profile = known.find((p) => p.signedIn) ?? known[0] ?? (await bridge.addProfile(serverUrl));
  await switchProfile(profile.id);
}

/** Changes kept in a profile's store and not yet sent. */
async function pendingChanges(profile: Profile): Promise<number> {
  const account = accountOf(profile.id);
  if (!account) return 0;
  const db = openOfflineDb(account.name);
  try {
    return await db.outbox.count();
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Removes a profile, its store, and what else the device kept for it, once `confirm` accepts the
 * changes it would lose; ends its session on the server, when it answers. Removing the active
 * profile moves the app to another, or to the connect screen. Returns whether it was removed.
 */
export async function removeProfile(
  profile: Profile,
  confirm: (pending: number) => Promise<boolean>,
): Promise<boolean> {
  const pending = await pendingChanges(profile);
  if (pending > 0 && !(await confirm(pending))) return false;
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
