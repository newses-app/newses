// Exposes the platform bridge to the web app; everything runs in the main process over IPC.
import type {
  AppNotification,
  AppTheme,
  DesktopOptions,
  NetworkStatus,
  PlatformBridge,
  SaveFile,
  UpdateStatus,
} from '@newses/shared';
import { contextBridge, ipcRenderer } from 'electron';

// The preload runs in the window, but is typed with the main process's libraries, which have no DOM.
declare const navigator: { readonly onLine: boolean };
declare const window: {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
};

const invoke = <T>(method: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`bridge:${method}`, ...args) as Promise<T>;

const VERSION_ARG = '--newses-version=';

// A single handler, replaced by later registrations.
let navigate: (target: string) => void = () => undefined;
const refreshers = new Set<() => void>();
ipcRenderer.on('bridge:navigate', (_event, target: string) => {
  navigate(target);
});
ipcRenderer.on('bridge:refresh', () => {
  for (const listener of refreshers) listener();
});

/** Chromium tells whether there is a network, not which kind. */
const network = (): NetworkStatus => ({ connected: navigator.onLine, wifi: null });

const bridge: PlatformBridge = {
  platform: 'desktop',
  appVersion:
    process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? '',
  getServerUrl: () => invoke<string | null>('getServerUrl'),
  setServerUrl: (url: string) => invoke<undefined>('setServerUrl', url),
  getToken: () => invoke<string | null>('getToken'),
  setToken: (token: string) => invoke<undefined>('setToken', token),
  clearToken: () => invoke<undefined>('clearToken'),
  openExternal: (url: string) => invoke<undefined>('openExternal', url),
  saveFile: (file: SaveFile) => invoke<boolean>('saveFile', file),
  notify: (notification: AppNotification) => invoke<undefined>('notify', notification),
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
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  },
  getDesktopOptions: () => invoke<DesktopOptions>('getDesktopOptions'),
  setDesktopOptions: (options) => invoke<undefined>('setDesktopOptions', options),
  // Sharing to the app is Android's.
  onShare: () => undefined,
  setTheme: (theme: AppTheme) => invoke<undefined>('setTheme', theme),
  // Desktop has no system back button.
  onBackButton: () => undefined,
  onUpdateStatus: (listener) => {
    ipcRenderer.on('bridge:updateStatus', (_event, status: UpdateStatus) => {
      listener(status);
    });
    void invoke<UpdateStatus>('getUpdateStatus').then(listener);
  },
  checkForUpdates: () => invoke<undefined>('checkForUpdates'),
  installUpdate: () => invoke<undefined>('installUpdate'),
};

contextBridge.exposeInMainWorld('rssReaderBridge', bridge);
