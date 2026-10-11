import type { PlatformBridge, SaveFile } from '@rss-reader/shared';

export type { PlatformBridge, SaveFile };

declare global {
  interface Window {
    rssReaderBridge?: PlatformBridge;
  }
}

function download(file: SaveFile): Promise<boolean> {
  const url = URL.createObjectURL(new Blob([file.data], { type: file.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
  return Promise.resolve(true);
}

/** The browser: same-origin server, cookie session, new tabs, and downloads. */
export const webBridge: PlatformBridge = {
  platform: 'web',
  appVersion: '',
  getServerUrl: () => Promise.resolve(null),
  setServerUrl: () => Promise.resolve(),
  getToken: () => Promise.resolve(null),
  setToken: () => Promise.resolve(),
  clearToken: () => Promise.resolve(),
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  },
  saveFile: download,
  notify: () => Promise.resolve(),
  setTheme: () => Promise.resolve(),
  onBackButton: () => undefined,
  // The browser loads the current web app; only the apps update.
  onUpdateStatus: (listener) => {
    listener({ state: 'unsupported' });
  },
  checkForUpdates: () => Promise.resolve(),
  installUpdate: () => Promise.resolve(),
};

/** The native build outside a shell (development, tests): like the browser, but remembers the server and token until reload. */
export function memoryBridge(): PlatformBridge {
  let serverUrl: string | null = null;
  let token: string | null = null;
  return {
    ...webBridge,
    getServerUrl: () => Promise.resolve(serverUrl),
    setServerUrl: (url) => {
      serverUrl = url;
      return Promise.resolve();
    },
    getToken: () => Promise.resolve(token),
    setToken: (value) => {
      token = value;
      return Promise.resolve();
    },
    clearToken: () => {
      token = null;
      return Promise.resolve();
    },
  };
}

/** The shell's bridge when there is one; otherwise the browser's, or in the native build, memory. */
export const selectBridge = (injected: PlatformBridge | undefined, native: boolean) =>
  injected ?? (native ? memoryBridge() : webBridge);
