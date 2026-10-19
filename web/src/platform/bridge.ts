import type { NetworkStatus, PlatformBridge, SaveFile, StagedPage } from '@newses/shared';
import { createProfiles, memoryProfileStorage } from '@newses/shared/client';

export type { NetworkStatus, PlatformBridge, SaveFile, StagedPage };

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

const noProfiles = () => Promise.reject(new Error('The browser uses its own server'));

/** The browser: same-origin server, cookie session, new tabs, and downloads. */
export const webBridge: PlatformBridge = {
  platform: 'web',
  appVersion: '',
  getProfiles: () => Promise.resolve({ profiles: [], active: null }),
  addProfile: noProfiles,
  updateProfile: noProfiles,
  setActiveProfile: noProfiles,
  removeProfile: noProfiles,
  onProfileSelected: () => undefined,
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
  // Installed browsers sync from the service worker instead (`offline/registration.ts`).
  setBackgroundSync: () => Promise.resolve(),
  takeBackgroundSync: () => Promise.resolve([]),
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

/** The native build outside a shell (development, tests): like the browser, but remembers profiles and tokens until reload. */
export function memoryBridge(): PlatformBridge {
  const profiles = createProfiles(memoryProfileStorage());
  return {
    ...webBridge,
    getProfiles: () => profiles.list(),
    addProfile: (serverUrl) => profiles.add(serverUrl),
    updateProfile: (id, changes) => profiles.update(id, changes),
    setActiveProfile: (id) => profiles.setActive(id),
    removeProfile: (id) => profiles.remove(id),
    getToken: () => profiles.getToken(),
    setToken: (token) => profiles.setToken(token),
    clearToken: () => profiles.clearToken(),
  };
}

/** The shell's bridge when there is one; otherwise the browser's, or in the native build, memory. */
export const selectBridge = (injected: PlatformBridge | undefined, native: boolean) =>
  injected ?? (native ? memoryBridge() : webBridge);
