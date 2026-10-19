import type { Profile } from '@newses/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { connection } from '../platform/index.ts';
import {
  DEFAULT_SETTINGS,
  EXTRA_PROFILE_LIMIT,
  limitsOverQuota,
  loadOfflineSettings,
  offlineSettings,
  profileLimits,
  saveSettings,
} from './settings.ts';

const profile = (id: string): Profile => ({
  id,
  serverUrl: `https://${id}.example`,
  userId: 1,
  login: 'ada',
  serverName: null,
  label: null,
  signedIn: true,
});

/** The app started on `active`, one of `ids`. */
function startOn(active: string, ids: string[]) {
  connection.state.profiles = ids.map(profile);
  connection.state.active = active;
  loadOfflineSettings();
}

afterEach(() => {
  connection.state.profiles = [];
  connection.state.active = null;
  localStorage.clear();
});

describe('offline settings', () => {
  it('starts the first profile at the default limit and later ones lower, and keeps both', () => {
    startOn('one', ['one']);
    expect(offlineSettings.limitBytes).toBe(DEFAULT_SETTINGS.limitBytes);
    startOn('two', ['one', 'two']);
    expect(offlineSettings.limitBytes).toBe(EXTRA_PROFILE_LIMIT);
    // Kept at once: the first profile's limit stays now that there are two.
    startOn('one', ['one', 'two']);
    expect(offlineSettings.limitBytes).toBe(DEFAULT_SETTINGS.limitBytes);
  });

  it('keeps the browser’s settings under one key, unsaved until changed', () => {
    loadOfflineSettings();
    expect(offlineSettings.limitBytes).toBe(DEFAULT_SETTINGS.limitBytes);
    expect(localStorage.length).toBe(0);
    saveSettings({ unread: 5000 });
    expect(localStorage.getItem('newses.offline.settings')).toContain('5000');
  });

  it('sums every profile’s limit to compare with what the device allows', () => {
    startOn('one', ['one', 'two']);
    saveSettings({ limitBytes: 4e9 });
    startOn('two', ['one', 'two', 'three']);
    const limits = profileLimits(connection.state.profiles);
    // Three has not been opened: it will start at the extra profiles' limit.
    expect(limits).toEqual([4e9, EXTRA_PROFILE_LIMIT, EXTRA_PROFILE_LIMIT]);
    expect(limitsOverQuota(limits, 5e9)).toBe(false);
    expect(limitsOverQuota(limits, 4e9)).toBe(true);
    expect(limitsOverQuota(limits, 0)).toBe(false);
  });
});
