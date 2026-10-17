import { OUTBOX_TAG, SYNC_TAG } from './worker-config.ts';

/** Syncs while no tab is open: at least this far apart, as browsers allow. */
const MIN_INTERVAL_MS = 30 * 60_000;

/** The parts of the Periodic Background Sync and Background Sync APIs used here (Chromium). */
interface PeriodicSync {
  register(tag: string, options: { minInterval: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
}
type Registration = ServiceWorkerRegistration & {
  periodicSync?: PeriodicSync;
  sync?: { register(tag: string): Promise<void> };
};

/**
 * Whether this browser syncs with no tab open: `on` or `off` as set; `notInstalled` where the
 * browser could (Chrome, Edge) but only grants it to installed apps; `unsupported` elsewhere
 * (Firefox, Safari), which sync while the app is open.
 */
export type BackgroundState = 'on' | 'off' | 'notInstalled' | 'unsupported';

async function registration(): Promise<Registration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return ((await navigator.serviceWorker.getRegistration()) as Registration | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Registers or removes the periodic sync, where the browser has it and grants it. */
export async function setPeriodicSync(on: boolean): Promise<BackgroundState> {
  const reg = await registration();
  if (!reg?.periodicSync) return 'unsupported';
  try {
    const { state } = await navigator.permissions.query({
      name: 'periodic-background-sync' as PermissionName,
    });
    if (state !== 'granted') return 'notInstalled';
    if (on) await reg.periodicSync.register(SYNC_TAG, { minInterval: MIN_INTERVAL_MS });
    else await reg.periodicSync.unregister(SYNC_TAG);
    return on ? 'on' : 'off';
  } catch {
    return 'notInstalled';
  }
}

/** Asks the browser to send the changes kept offline when the connection returns, tab or not. */
export async function requestOutboxSync(): Promise<void> {
  try {
    await (await registration())?.sync?.register(OUTBOX_TAG);
  } catch {
    // Not supported, or refused: the app sends them the next time it is open.
  }
}
