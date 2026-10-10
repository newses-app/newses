// The platform bridge on Android, built into www/bridge.js and loaded before the web app's scripts.
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import type { PlatformBridge, SaveFile } from '@rss-reader/shared';

declare const APP_VERSION: string;

const SERVER_KEY = 'serverUrl';
/** In Android Keystore-backed storage, not Preferences. */
const TOKEN_KEY = 'token';

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
  // A dark theme needs light status and navigation bar icons.
  setDarkTheme: (dark) =>
    SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }),
  onBackButton: (handler) => {
    backHandler = handler;
  },
};

window.rssReaderBridge = bridge;

declare global {
  interface Window {
    rssReaderBridge?: PlatformBridge;
  }
}
