// The platform bridge on Android (android-bridge.ts), built into www/bridge.js and loaded before
// the web app's scripts: the Capacitor plugins, and the app's own (android/…/*Plugin.java).
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { CapacitorHttp, registerPlugin, SystemBars } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import type { PlatformBridge } from '@newses/shared';
import {
  type BackgroundSyncPlugin,
  createAndroidBridge,
  type ShareTargetPlugin,
} from './android-bridge.ts';

declare const APP_VERSION: string;
/** The stage's downloads, from the release build; empty in local builds, which never update. */
declare const DOWNLOADS_URL: string;

window.rssReaderBridge = createAndroidBridge(
  {
    app: App,
    browser: Browser,
    filesystem: Filesystem,
    http: CapacitorHttp,
    network: Network,
    preferences: Preferences,
    secureStorage: SecureStorage,
    share: Share,
    systemBars: SystemBars,
    shareTarget: registerPlugin<ShareTargetPlugin>('ShareTarget'),
    backgroundSync: registerPlugin<BackgroundSyncPlugin>('BackgroundSync'),
  },
  { appVersion: APP_VERSION, downloadsUrl: DOWNLOADS_URL },
);

declare global {
  interface Window {
    rssReaderBridge?: PlatformBridge;
  }
}
