// The platform bridge on Android, built into www/bridge.js and loaded before the web app's scripts.
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import {
  CapacitorHttp,
  type PluginListenerHandle,
  registerPlugin,
  SystemBars,
  SystemBarsStyle,
} from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { type ConnectionStatus, Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { createProfiles } from '@newses/shared/profiles';
import type {
  NetworkStatus,
  PlatformBridge,
  SaveFile,
  StagedPage,
  UpdateStatus,
} from '@newses/shared';
import { capacitorProfileStorage } from './profiles.ts';
import { type AndroidUpdate, androidUpdate, checkDue, parseCheckRecord } from './updates.ts';

declare const APP_VERSION: string;
/** The stage's downloads, from the release build; empty in local builds, which never update. */
declare const DOWNLOADS_URL: string;

const UPDATE_CHECK_KEY = 'updateCheck';

/** Profiles in Preferences; their tokens in Android Keystore-backed storage. */
const profiles = createProfiles(
  capacitorProfileStorage(
    {
      get: async (key) => (await Preferences.get({ key })).value,
      set: (key, value) => Preferences.set({ key, value }),
      remove: (key) => Preferences.remove({ key }),
    },
    {
      get: (key) => SecureStorage.getItem(key),
      set: (key, value) => SecureStorage.setItem(key, value),
      remove: (key) => SecureStorage.removeItem(key),
    },
  ),
);

/** The active profile, its server, and its token, for the background job. */
async function activeConnection() {
  const { profiles: list, active } = await profiles.list();
  const serverUrl = list.find((p) => p.id === active)?.serverUrl ?? null;
  return { profileId: active, serverUrl, token: serverUrl ? await profiles.getToken() : null };
}

/** The app's own plugin (android/…/ShareTargetPlugin.java): text from the share sheet. */
const ShareTarget = registerPlugin<{
  addListener(
    event: 'share',
    listener: (data: { text: string; subject?: string }) => void,
  ): Promise<PluginListenerHandle>;
}>('ShareTarget');

/**
 * The app's own plugin (android/…/BackgroundSyncPlugin.java): a WorkManager job that fetches
 * changes and article text while the app is closed, for the web app to store when it opens.
 */
const BackgroundSync = registerPlugin<{
  configure(options: {
    enabled: boolean;
    wifiOnly: boolean;
    syncToken: string | null;
    profileId: string | null;
    serverUrl: string | null;
    token: string | null;
  }): Promise<void>;
  /** Pages fetched for the profile; any other profile's are dropped. */
  take(options: { profileId: string | null }): Promise<{ pages: StagedPage[] }>;
}>('BackgroundSync');

/** Shares wait here until the web app sets its handler. */
let shareHandler: ((text: string, subject: string | null) => void) | null = null;
const sharedTexts: { text: string; subject: string | null }[] = [];
void ShareTarget.addListener('share', ({ text, subject }) => {
  if (shareHandler) shareHandler(text, subject ?? null);
  else sharedTexts.push({ text, subject: subject ?? null });
});

const refreshers = new Set<() => void>();
void App.addListener('resume', () => {
  for (const listener of refreshers) listener();
});

const networkStatus = ({ connected, connectionType }: ConnectionStatus): NetworkStatus => ({
  connected,
  wifi: connectionType === 'unknown' ? null : connectionType === 'wifi',
});
const networkListeners = new Set<(status: NetworkStatus) => void>();
void Network.addListener('networkStatusChange', (status) => {
  for (const listener of networkListeners) listener(networkStatus(status));
});

let backHandler: (() => boolean) | null = null;
void App.addListener('backButton', () => {
  if (!backHandler?.()) void App.exitApp();
});

/** Writes the file to the cache and offers it through the share sheet (Files, Drive, …). */
async function saveFile(file: SaveFile): Promise<boolean> {
  const { uri } = await Filesystem.writeFile({
    path: file.name,
    data: file.data,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  try {
    await Share.share({ title: file.name, files: [uri] });
    return true;
  } catch {
    // Dismissed.
    return false;
  }
}

let updateStatus: UpdateStatus = { state: DOWNLOADS_URL ? 'idle' : 'unsupported' };
let update: AndroidUpdate | null = null;
const updateListeners: ((status: UpdateStatus) => void)[] = [];

function setUpdate(found: AndroidUpdate | null) {
  update = found;
  setUpdateStatus(found ? { state: 'available', version: found.version } : { state: 'current' });
}

function setUpdateStatus(status: UpdateStatus) {
  updateStatus = status;
  for (const listener of updateListeners) listener(status);
}

/** Fetched natively, so the downloads need no CORS for the app's origin. */
async function checkForUpdates() {
  if (!DOWNLOADS_URL) return;
  setUpdateStatus({ state: 'checking' });
  try {
    const response = await CapacitorHttp.get({
      url: `${DOWNLOADS_URL}/latest.json`,
      responseType: 'json',
    });
    if (response.status !== 200) throw new Error(`HTTP ${String(response.status)}`);
    const { build } = await App.getInfo();
    const found = androidUpdate(response.data, Number(build), DOWNLOADS_URL);
    await Preferences.set({
      key: UPDATE_CHECK_KEY,
      value: JSON.stringify({ checkedAt: Date.now(), update: found }),
    });
    setUpdate(found);
  } catch {
    setUpdateStatus({ state: 'failed' });
  }
}

/** At launch at most daily; in between, the last check's result while it is still newer. */
async function checkAtLaunch() {
  if (!DOWNLOADS_URL) return;
  const record = parseCheckRecord((await Preferences.get({ key: UPDATE_CHECK_KEY })).value);
  if (checkDue(record, Date.now())) {
    await checkForUpdates();
    return;
  }
  const { build } = await App.getInfo();
  const stored = record?.update;
  setUpdate(stored && stored.versionCode > Number(build) ? stored : null);
}
void checkAtLaunch();

const bridge: PlatformBridge = {
  platform: 'android',
  appVersion: APP_VERSION,
  getProfiles: () => profiles.list(),
  addProfile: (serverUrl) => profiles.add(serverUrl),
  updateProfile: (id, changes) => profiles.update(id, changes),
  setActiveProfile: (id) => profiles.setActive(id),
  removeProfile: (id) => profiles.remove(id),
  // Profiles are picked in the app only.
  onProfileSelected: () => undefined,
  getToken: () => profiles.getToken(),
  setToken: (token) => profiles.setToken(token),
  clearToken: () => profiles.clearToken(),
  // Custom Tabs: the system browser, over the app.
  openExternal: (url) => Browser.open({ url }),
  saveFile,
  // Android notifications are not part of the app yet.
  notify: () => Promise.resolve(),
  onNavigate: () => undefined,
  onRefresh: (listener) => {
    refreshers.add(listener);
    return () => {
      refreshers.delete(listener);
    };
  },
  getNetwork: async () => networkStatus(await Network.getStatus()),
  onNetworkChange: (listener) => {
    networkListeners.add(listener);
    return () => {
      networkListeners.delete(listener);
    };
  },
  // The job is handed the server and token here, so the web app never passes the token on.
  setBackgroundSync: async (options) =>
    BackgroundSync.configure({
      ...options,
      ...(options.enabled
        ? await activeConnection()
        : { profileId: null, serverUrl: null, token: null }),
    }),
  takeBackgroundSync: async () =>
    (await BackgroundSync.take({ profileId: (await profiles.list()).active })).pages,
  getDesktopOptions: () => Promise.resolve(null),
  setDesktopOptions: () => Promise.resolve(),
  onShare: (handler) => {
    shareHandler = handler;
    for (const { text, subject } of sharedTexts.splice(0)) handler(text, subject);
  },
  // The app draws edge to edge, so the bars show the page's theme background; over a dark one
  // their icons must be light.
  setTheme: ({ dark }) =>
    SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }),
  onBackButton: (handler) => {
    backHandler = handler;
  },
  onUpdateStatus: (listener) => {
    updateListeners.push(listener);
    listener(updateStatus);
  },
  checkForUpdates,
  // The browser downloads the APK and hands it to the package installer.
  installUpdate: async () => {
    if (update) await Browser.open({ url: update.url });
  },
};

window.rssReaderBridge = bridge;

declare global {
  interface Window {
    rssReaderBridge?: PlatformBridge;
  }
}
