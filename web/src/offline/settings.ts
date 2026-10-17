import { reactive } from 'vue';
import { DEFAULT_KEEP, type KeepLimits } from '../lib/offline-keep.ts';
import { DEFAULT_STORAGE_LIMIT } from './downloads.ts';

/** What this device keeps for reading offline; set per device, as devices differ in space. */
export interface OfflineSettings {
  /** Unread entries kept, newest first; starred and recently read ones are kept as well. */
  unread: number;
  images: boolean;
  /** On Android, images download only on Wi-Fi. */
  wifiOnly: boolean;
  /** Content and images together stay under this. */
  limitBytes: number;
  /**
   * Syncs while the app is closed: from the service worker in installed Chrome and Edge apps,
   * from a background job on Android.
   */
  background: boolean;
}

const KEY = 'newses.offline.settings';

export const UNREAD_CHOICES = [1000, 5000, 10_000] as const;
export const LIMIT_CHOICES = [256 * 1024 * 1024, DEFAULT_STORAGE_LIMIT, 4 * DEFAULT_STORAGE_LIMIT];

export const DEFAULT_SETTINGS: OfflineSettings = {
  unread: DEFAULT_KEEP.unread,
  images: true,
  wifiOnly: true,
  limitBytes: DEFAULT_STORAGE_LIMIT,
  background: true,
};

function load(): OfflineSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<OfflineSettings>;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const offlineSettings = reactive(load());

export function saveSettings(change: Partial<OfflineSettings>): void {
  Object.assign(offlineSettings, change);
  try {
    localStorage.setItem(KEY, JSON.stringify(offlineSettings));
  } catch {
    // Storage blocked: the settings last until the page closes.
  }
}

/** What the store keeps under the current settings. */
export const keepLimits = (): KeepLimits => ({ ...DEFAULT_KEEP, unread: offlineSettings.unread });

/** Whether images download now: when kept, and on Android on Wi-Fi unless allowed otherwise. */
export const imagesNow = (wifi: boolean | null) =>
  offlineSettings.images && (!offlineSettings.wifiOnly || wifi !== false);
