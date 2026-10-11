// Exposes the platform bridge to the web app; everything runs in the main process over IPC.
import type {
  AppNotification,
  AppTheme,
  DesktopOptions,
  PlatformBridge,
  SaveFile,
  UpdateStatus,
} from '@rss-reader/shared';
import { contextBridge, ipcRenderer } from 'electron';

const invoke = <T>(method: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`bridge:${method}`, ...args) as Promise<T>;

const VERSION_ARG = '--rss-reader-version=';

// Single handlers, replaced by later registrations.
let navigate: (target: string) => void = () => undefined;
let refresh: () => void = () => undefined;
ipcRenderer.on('bridge:navigate', (_event, target: string) => {
  navigate(target);
});
ipcRenderer.on('bridge:refresh', () => {
  refresh();
});

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
  onRefresh: (handler) => {
    refresh = handler;
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
