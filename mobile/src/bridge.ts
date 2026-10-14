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
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import type { PlatformBridge, SaveFile, UpdateStatus } from '@newses/shared';
import { type AndroidUpdate, androidUpdate, checkDue, parseCheckRecord } from './updates.ts';

declare const APP_VERSION: string;
/** The stage's downloads, from the release build; empty in local builds, which never update. */
declare const DOWNLOADS_URL: string;

const SERVER_KEY = 'serverUrl';
/** In Android Keystore-backed storage, not Preferences. */
const TOKEN_KEY = 'token';
const UPDATE_CHECK_KEY = 'updateCheck';

/** The app's own plugin (android/…/ShareTargetPlugin.java): text from the share sheet. */
const ShareTarget = registerPlugin<{
  addListener(
    event: 'share',
    listener: (data: { text: string }) => void,
  ): Promise<PluginListenerHandle>;
}>('ShareTarget');

/** Shares wait here until the web app sets its handler. */
let shareHandler: ((text: string) => void) | null = null;
const sharedTexts: string[] = [];
void ShareTarget.addListener('share', ({ text }) => {
  if (shareHandler) shareHandler(text);
  else sharedTexts.push(text);
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
  getServerUrl: async () => (await Preferences.get({ key: SERVER_KEY })).value,
  setServerUrl: (url) => Preferences.set({ key: SERVER_KEY, value: url }),
  getToken: () => SecureStorage.getItem(TOKEN_KEY),
  setToken: (token) => SecureStorage.setItem(TOKEN_KEY, token),
  clearToken: () => SecureStorage.removeItem(TOKEN_KEY),
  // Custom Tabs: the system browser, over the app.
  openExternal: (url) => Browser.open({ url }),
  saveFile,
  // Android notifications are not part of the app yet.
  notify: () => Promise.resolve(),
  onNavigate: () => undefined,
  onRefresh: () => undefined,
  getDesktopOptions: () => Promise.resolve(null),
  setDesktopOptions: () => Promise.resolve(),
  onShare: (handler) => {
    shareHandler = handler;
    for (const text of sharedTexts.splice(0)) handler(text);
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
