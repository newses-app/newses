import { reactive } from 'vue';
import { DEFAULT_KEEP, type KeepLimits } from '../lib/offline-keep.ts';
import type { Profile } from '@newses/shared';
import { connection } from '../platform/index.ts';
import { profileKey } from '../platform/profile-keys.ts';
import { DEFAULT_STORAGE_LIMIT } from './downloads.ts';

/**
 * What this device keeps for reading offline; set per device, as devices differ in space, and in
 * the apps per profile.
 */
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
/** Profiles after the first start with it, so several fill a device more slowly. */
export const EXTRA_PROFILE_LIMIT = 256 * 1024 * 1024;
export const LIMIT_CHOICES = [
  EXTRA_PROFILE_LIMIT,
  DEFAULT_STORAGE_LIMIT,
  4 * DEFAULT_STORAGE_LIMIT,
];

export const DEFAULT_SETTINGS: OfflineSettings = {
  unread: DEFAULT_KEEP.unread,
  images: true,
  wifiOnly: true,
  limitBytes: DEFAULT_STORAGE_LIMIT,
  background: true,
};

/** The settings a profile starts with: profiles after the first keep less. */
export const defaultSettings = (otherProfiles: number): OfflineSettings => ({
  ...DEFAULT_SETTINGS,
  ...(otherProfiles > 0 && { limitBytes: EXTRA_PROFILE_LIMIT }),
});

export const offlineSettings = reactive({ ...DEFAULT_SETTINGS });

function saved(key: string): Partial<OfflineSettings> | null {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as Partial<OfflineSettings>) : null;
  } catch {
    // Storage blocked, or an unreadable entry: the defaults apply.
    return null;
  }
}

/**
 * Reads the settings once the active profile is known. A profile's first are kept at once, so
 * its starting limit stays when profiles are added or removed later.
 */
export function loadOfflineSettings(): void {
  const kept = saved(profileKey(KEY));
  const others = connection.state.profiles.length - 1;
  Object.assign(offlineSettings, kept ? { ...DEFAULT_SETTINGS, ...kept } : defaultSettings(others));
  if (!kept && connection.state.active) saveSettings({});
}

export function saveSettings(change: Partial<OfflineSettings>): void {
  Object.assign(offlineSettings, change);
  try {
    localStorage.setItem(profileKey(KEY), JSON.stringify(offlineSettings));
  } catch {
    // Storage blocked: the settings last until the page closes.
  }
}

/** What the store keeps under the current settings. */
export const keepLimits = (): KeepLimits => ({ ...DEFAULT_KEEP, unread: offlineSettings.unread });

/** Whether images download now: when kept, and on Android on Wi-Fi unless allowed otherwise. */
export const imagesNow = (wifi: boolean | null) =>
  offlineSettings.images && (!offlineSettings.wifiOnly || wifi !== false);

/** Each profile's storage limit; one not opened since it was added starts at its default. */
export function profileLimits(profiles: readonly Profile[]): number[] {
  return profiles.map((profile) =>
    profile.id === connection.state.active
      ? offlineSettings.limitBytes
      : (saved(profileKey(KEY, profile.id))?.limitBytes ??
        defaultSettings(profiles.length - 1).limitBytes),
  );
}

/** Whether the limits together pass what the device lets the app keep. */
export const limitsOverQuota = (limits: readonly number[], quota: number) =>
  quota > 0 && limits.reduce((sum, limit) => sum + limit, 0) > quota;
