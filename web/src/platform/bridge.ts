/** A file the user is offered to save. */
export interface SaveFile {
  name: string;
  type: string;
  data: string;
}

/**
 * Native features of the desktop and mobile apps. Their shells set `window.rssReaderBridge` before
 * the app's scripts run; the browser gets `webBridge`.
 */
export interface PlatformBridge {
  readonly platform: 'web' | 'desktop' | 'android';
  /** The app's version; empty in a browser. */
  readonly appVersion: string;
  /** The server chosen at the connect screen; null until one is. */
  getServerUrl(): Promise<string | null>;
  setServerUrl(url: string): Promise<void>;
  /** The bearer session token from OS secure storage; null when signed out or not kept. */
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  /** Opens an http(s) URL in the system browser. */
  openExternal(url: string): Promise<void>;
  /** Offers a file to save; false when the user cancels. */
  saveFile(file: SaveFile): Promise<boolean>;
  /** Shows a system notification. */
  notify(notification: { title: string; body: string }): Promise<void>;
}

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
