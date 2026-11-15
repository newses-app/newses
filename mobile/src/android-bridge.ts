// The platform bridge on Android, over the Capacitor plugins bridge.ts hands it.
import type { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { App } from '@capacitor/app';
import type { Browser } from '@capacitor/browser';
import {
  type CapacitorHttp,
  type PluginListenerHandle,
  type SystemBars,
  SystemBarsStyle,
} from '@capacitor/core';
import { Directory, Encoding, type Filesystem } from '@capacitor/filesystem';
import type { ConnectionStatus, Network } from '@capacitor/network';
import type { Preferences } from '@capacitor/preferences';
import type { Share } from '@capacitor/share';
import { createProfiles } from '@newses/shared/profiles';
import { shareBody } from '@newses/shared/share-link';
import type {
  NetworkStatus,
  NewEntriesHandover,
  NotificationAccess,
  PlatformBridge,
  PushServiceStatus,
  SaveFile,
  ShareLink,
  StagedPage,
  UpdateStatus,
} from '@newses/shared';
import { capacitorProfileStorage } from './profiles.ts';
import { type AndroidUpdate, androidUpdate, checkDue, parseCheckRecord } from './updates.ts';

export const UPDATE_CHECK_KEY = 'updateCheck';

/** The app's own plugin (android/…/ShareTargetPlugin.java): text from the share sheet. */
export interface ShareTargetPlugin {
  addListener(
    event: 'share',
    listener: (data: { text: string; subject?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * The app's own plugin (android/…/BackgroundSyncPlugin.java): a WorkManager job that fetches
 * changes and article text while the app is closed, for the web app to store when it opens, and
 * notifies of new entries it finds.
 */
export interface BackgroundSyncPlugin {
  configure(options: {
    enabled: boolean;
    wifiOnly: boolean;
    syncToken: string | null;
    notify?: NewEntriesHandover | null;
    pushKey?: string | null;
    profileId: string | null;
    serverUrl: string | null;
    token: string | null;
  }): Promise<void>;
  /** Pages fetched for the profile; any other profile's are dropped. */
  take(options: { profileId: string | null }): Promise<{ pages: StagedPage[] }>;
  notificationAccess(options: { ask: boolean }): Promise<{ state: NotificationAccess }>;
  pushStatus(): Promise<PushServiceStatus>;
  choosePushService(): Promise<PushServiceStatus>;
  /** A tapped notification's stream, including one that launched the app. */
  addListener(
    event: 'navigate',
    listener: (data: { target: string }) => void,
  ): Promise<PluginListenerHandle>;
}

/** The plugins the bridge uses. */
export interface AndroidPlugins {
  app: Pick<typeof App, 'addListener' | 'exitApp' | 'getInfo'>;
  browser: Pick<typeof Browser, 'open'>;
  filesystem: Pick<typeof Filesystem, 'writeFile'>;
  http: Pick<typeof CapacitorHttp, 'get'>;
  network: Pick<typeof Network, 'addListener' | 'getStatus'>;
  preferences: Pick<typeof Preferences, 'get' | 'set' | 'remove'>;
  secureStorage: Pick<typeof SecureStorage, 'getItem' | 'setItem' | 'removeItem'>;
  share: Pick<typeof Share, 'share'>;
  systemBars: Pick<typeof SystemBars, 'setStyle'>;
  shareTarget: ShareTargetPlugin;
  backgroundSync: BackgroundSyncPlugin;
}

export interface AndroidBuild {
  appVersion: string;
  /** The stage's downloads, from the release build; empty in local builds, which never update. */
  downloadsUrl: string;
}

const networkStatus = ({ connected, connectionType }: ConnectionStatus): NetworkStatus => ({
  connected,
  wifi: connectionType === 'unknown' ? null : connectionType === 'wifi',
});

/** The bridge; it starts listening to the plugins, and checks for updates at launch. */
export function createAndroidBridge(plugins: AndroidPlugins, build: AndroidBuild): PlatformBridge {
  const { app, backgroundSync, browser, network, preferences, secureStorage } = plugins;
  const { downloadsUrl } = build;

  /** Profiles in Preferences; their tokens in Android Keystore-backed storage. */
  const profiles = createProfiles(
    capacitorProfileStorage(
      {
        get: async (key) => (await preferences.get({ key })).value,
        set: (key, value) => preferences.set({ key, value }),
        remove: (key) => preferences.remove({ key }),
      },
      {
        get: (key) => secureStorage.getItem(key),
        set: (key, value) => secureStorage.setItem(key, value),
        remove: (key) => secureStorage.removeItem(key),
      },
    ),
  );

  /** The active profile, its server, and its token, for the background job. */
  async function activeConnection() {
    const { profiles: list, active } = await profiles.list();
    const serverUrl = list.find((p) => p.id === active)?.serverUrl ?? null;
    return { profileId: active, serverUrl, token: serverUrl ? await profiles.getToken() : null };
  }

  /** Shares wait here until the web app sets its handler. */
  let shareHandler: ((text: string, subject: string | null) => void) | null = null;
  const sharedTexts: { text: string; subject: string | null }[] = [];
  void plugins.shareTarget.addListener('share', ({ text, subject }) => {
    if (shareHandler) shareHandler(text, subject ?? null);
    else sharedTexts.push({ text, subject: subject ?? null });
  });

  /** A tapped notification's stream waits here until the web app sets its handler. */
  let navigateHandler: ((target: string) => void) | null = null;
  let navigateTarget: string | null = null;
  void backgroundSync.addListener('navigate', ({ target }) => {
    if (navigateHandler) navigateHandler(target);
    else navigateTarget = target;
  });

  const refreshers = new Set<() => void>();
  void app.addListener('resume', () => {
    for (const listener of refreshers) listener();
  });

  const networkListeners = new Set<(status: NetworkStatus) => void>();
  void network.addListener('networkStatusChange', (status) => {
    for (const listener of networkListeners) listener(networkStatus(status));
  });

  let backHandler: (() => boolean) | null = null;
  void app.addListener('backButton', () => {
    if (!backHandler?.()) void app.exitApp();
  });

  /** Writes the file to the cache and offers it through the share sheet (Files, Drive, …). */
  async function saveFile(file: SaveFile): Promise<boolean> {
    const { uri } = await plugins.filesystem.writeFile({
      path: file.name,
      data: file.data,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await plugins.share.share({ title: file.name, files: [uri] });
      return true;
    } catch {
      // Dismissed.
      return false;
    }
  }

  /**
   * The share sheet, the title as a mail's subject. The plugin would join text and link with a
   * space; the body keeps the link on its own line.
   */
  async function shareLink(link: ShareLink): Promise<boolean> {
    try {
      await plugins.share.share({ title: link.title, text: shareBody(link) });
      return true;
    } catch {
      // Dismissed.
      return false;
    }
  }

  let updateStatus: UpdateStatus = { state: downloadsUrl ? 'idle' : 'unsupported' };
  let update: AndroidUpdate | null = null;
  const updateListeners: ((status: UpdateStatus) => void)[] = [];

  function setUpdateStatus(status: UpdateStatus) {
    updateStatus = status;
    for (const listener of updateListeners) listener(status);
  }

  function setUpdate(found: AndroidUpdate | null) {
    update = found;
    setUpdateStatus(found ? { state: 'available', version: found.version } : { state: 'current' });
  }

  /** Fetched natively, so the downloads need no CORS for the app's origin. */
  async function checkForUpdates() {
    if (!downloadsUrl) return;
    setUpdateStatus({ state: 'checking' });
    try {
      const response = await plugins.http.get({
        url: `${downloadsUrl}/latest.json`,
        responseType: 'json',
      });
      if (response.status !== 200) throw new Error(`HTTP ${String(response.status)}`);
      const { build: code } = await app.getInfo();
      const found = androidUpdate(response.data, Number(code), downloadsUrl);
      await preferences.set({
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
    if (!downloadsUrl) return;
    const record = parseCheckRecord((await preferences.get({ key: UPDATE_CHECK_KEY })).value);
    if (checkDue(record, Date.now())) {
      await checkForUpdates();
      return;
    }
    const { build: code } = await app.getInfo();
    const stored = record?.update;
    setUpdate(stored && stored.versionCode > Number(code) ? stored : null);
  }
  void checkAtLaunch();

  return {
    platform: 'android',
    appVersion: build.appVersion,
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
    openExternal: (url) => browser.open({ url }),
    shareLink,
    saveFile,
    // The background job shows the only notification, of new entries while the app is closed.
    notify: () => Promise.resolve(),
    notificationAccess: async (ask) => (await backgroundSync.notificationAccess({ ask })).state,
    onNavigate: (handler) => {
      navigateHandler = handler;
      if (navigateTarget !== null) handler(navigateTarget);
      navigateTarget = null;
    },
    onRefresh: (listener) => {
      refreshers.add(listener);
      return () => {
        refreshers.delete(listener);
      };
    },
    getNetwork: async () => networkStatus(await network.getStatus()),
    onNetworkChange: (listener) => {
      networkListeners.add(listener);
      return () => {
        networkListeners.delete(listener);
      };
    },
    // The job is handed the server and token here, so the web app never passes the token on.
    setBackgroundSync: async (options) =>
      backgroundSync.configure({
        ...options,
        ...(options.enabled
          ? await activeConnection()
          : { profileId: null, serverUrl: null, token: null }),
      }),
    takeBackgroundSync: async () =>
      (await backgroundSync.take({ profileId: (await profiles.list()).active })).pages,
    pushStatus: () => backgroundSync.pushStatus(),
    choosePushService: () => backgroundSync.choosePushService(),
    getDesktopOptions: () => Promise.resolve(null),
    setDesktopOptions: () => Promise.resolve(),
    onShare: (handler) => {
      shareHandler = handler;
      for (const { text, subject } of sharedTexts.splice(0)) handler(text, subject);
    },
    // Android has no menus of its own: everything shown comes from the web app.
    setLanguage: () => Promise.resolve(),
    // The app draws edge to edge, so the bars show the page's theme background; over a dark one
    // their icons must be light.
    setTheme: ({ dark }) =>
      plugins.systemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }),
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
      if (update) await browser.open({ url: update.url });
    },
  };
}
