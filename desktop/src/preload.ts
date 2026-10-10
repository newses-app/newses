// Exposes the platform bridge to the web app; everything runs in the main process over IPC.
import type { AppTheme, PlatformBridge, SaveFile } from '@rss-reader/shared';
import { contextBridge, ipcRenderer } from 'electron';

const invoke = <T>(method: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`bridge:${method}`, ...args) as Promise<T>;

const VERSION_ARG = '--rss-reader-version=';

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
  notify: (notification: { title: string; body: string }) =>
    invoke<undefined>('notify', notification),
  setTheme: (theme: AppTheme) => invoke<undefined>('setTheme', theme),
  // Desktop has no system back button.
  onBackButton: () => undefined,
};

contextBridge.exposeInMainWorld('rssReaderBridge', bridge);
