// The platform bridge the preload (preload.ts) exposes to the web app; everything runs in the main
// process over IPC (ipc.ts).
import type {
  AppNotification,
  AppTheme,
  DesktopOptions,
  NetworkStatus,
  PlatformBridge,
  Profile,
  ProfileChanges,
  ProfileList,
  SaveFile,
  ShareLink,
  UpdateStatus,
} from '@newses/shared';

/** What the bridge uses of Electron's `ipcRenderer`. */
export interface RendererIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** The window the preload runs in, typed here without the DOM libraries. */
export interface BridgePage {
  /** The process's arguments, which carry the app's version. */
  argv: readonly string[];
  navigator: { readonly onLine: boolean };
  window: {
    addEventListener(type: 'online' | 'offline', listener: () => void): void;
    removeEventListener(type: 'online' | 'offline', listener: () => void): void;
  };
}

const VERSION_ARG = '--newses-version=';

export function createDesktopBridge(ipc: RendererIpc, page: BridgePage): PlatformBridge {
  const invoke = <T>(method: string, ...args: unknown[]) =>
    ipc.invoke(`bridge:${method}`, ...args) as Promise<T>;

  // Single handlers, replaced by later registrations.
  let navigate: (target: string) => void = () => undefined;
  let selectProfile: (id: string) => void = () => undefined;
  const refreshers = new Set<() => void>();
  ipc.on('bridge:navigate', (_event, target) => {
    navigate(target as string);
  });
  ipc.on('bridge:selectProfile', (_event, id) => {
    selectProfile(id as string);
  });
  ipc.on('bridge:refresh', () => {
    for (const listener of refreshers) listener();
  });

  /** Chromium tells whether there is a network, not which kind. */
  const network = (): NetworkStatus => ({ connected: page.navigator.onLine, wifi: null });

  return {
    platform: 'desktop',
    appVersion:
      page.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? '',
    getProfiles: () => invoke<ProfileList>('getProfiles'),
    addProfile: (serverUrl: string) => invoke<Profile>('addProfile', serverUrl),
    updateProfile: (id: string, changes: ProfileChanges) =>
      invoke<undefined>('updateProfile', id, changes),
    setActiveProfile: (id: string) => invoke<undefined>('setActiveProfile', id),
    removeProfile: (id: string) => invoke<string | null>('removeProfile', id),
    onProfileSelected: (handler) => {
      selectProfile = handler;
    },
    getToken: () => invoke<string | null>('getToken'),
    setToken: (token: string) => invoke<undefined>('setToken', token),
    clearToken: () => invoke<undefined>('clearToken'),
    openExternal: (url: string) => invoke<undefined>('openExternal', url),
    shareLink: (link: ShareLink) => invoke<boolean>('shareLink', link),
    saveFile: (file: SaveFile) => invoke<boolean>('saveFile', file),
    notify: (notification: AppNotification) => invoke<undefined>('notify', notification),
    // The window is granted the notification permission; the system's own settings may still mute them.
    notificationAccess: () => Promise.resolve('granted'),
    onNavigate: (handler) => {
      navigate = handler;
    },
    onRefresh: (listener) => {
      refreshers.add(listener);
      return () => {
        refreshers.delete(listener);
      };
    },
    getNetwork: () => Promise.resolve(network()),
    onNetworkChange: (listener) => {
      const changed = () => {
        listener(network());
      };
      page.window.addEventListener('online', changed);
      page.window.addEventListener('offline', changed);
      return () => {
        page.window.removeEventListener('online', changed);
        page.window.removeEventListener('offline', changed);
      };
    },
    // The desktop app keeps running in the tray, where it syncs on its own schedule.
    setBackgroundSync: () => Promise.resolve(),
    takeBackgroundSync: () => Promise.resolve([]),
    pushStatus: () => Promise.resolve({ state: 'unsupported' }),
    choosePushService: () => Promise.resolve({ state: 'unsupported' }),
    getDesktopOptions: () => invoke<DesktopOptions>('getDesktopOptions'),
    setDesktopOptions: (options) => invoke<undefined>('setDesktopOptions', options),
    // Sharing to the app is Android's.
    onShare: () => undefined,
    setTheme: (theme: AppTheme) => invoke<undefined>('setTheme', theme),
    setLanguage: (code: string) => invoke<undefined>('setLanguage', code),
    // Desktop has no system back button.
    onBackButton: () => undefined,
    onUpdateStatus: (listener) => {
      ipc.on('bridge:updateStatus', (_event, status) => {
        listener(status as UpdateStatus);
      });
      void invoke<UpdateStatus>('getUpdateStatus').then(listener);
    },
    checkForUpdates: () => invoke<undefined>('checkForUpdates'),
    installUpdate: () => invoke<undefined>('installUpdate'),
  };
}
