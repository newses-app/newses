import type { NetworkStatus, PlatformBridge, SaveFile } from '@newses/shared';

export type { NetworkStatus, PlatformBridge, SaveFile };

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

/** Browsers report whether there is a network at all, not which kind. */
const browserNetwork = (): NetworkStatus => ({ connected: navigator.onLine, wifi: null });

function onBrowserNetworkChange(listener: (status: NetworkStatus) => void): () => void {
  const changed = () => {
    listener(browserNetwork());
  };
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
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
  onNavigate: () => undefined,
  onRefresh: () => () => undefined,
  getNetwork: () => Promise.resolve(browserNetwork()),
  onNetworkChange: onBrowserNetworkChange,
  getDesktopOptions: () => Promise.resolve(null),
  setDesktopOptions: () => Promise.resolve(),
  onShare: () => undefined,
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
