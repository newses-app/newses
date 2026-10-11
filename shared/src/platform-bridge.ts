// The contract between the web app and the desktop and mobile shells (types only).

/** A file the user is offered to save. */
export interface SaveFile {
  name: string;
  type: string;
  data: string;
}

export interface AppTheme {
  preference: 'system' | 'light' | 'dark';
  dark: boolean;
}

/**
 * Whether a newer app is published on the stage's downloads. `ready` installs on restart (desktop
 * installs that update themselves); `available` is downloaded by the user (Linux deb, Windows zip,
 * Android). `unsupported`: the browser, and builds without an update feed.
 */
export type UpdateStatus =
  | { state: 'unsupported' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'available'; version: string }
  | { state: 'failed' };

/**
 * Native features of the desktop and mobile apps. Their shells set `window.rssReaderBridge` before
 * the web app's scripts run; the browser gets a stand-in.
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
  /**
   * The app's theme: the reader's preference, and whether it is dark now. Desktop follows the
   * preference (so `system` keeps tracking the OS); Android colours its system bar icons by `dark`.
   */
  setTheme(theme: AppTheme): Promise<void>;
  /**
   * Called on the system back button (Android); the handler returns false when it had nothing to
   * close or go back to, and the app then exits.
   */
  onBackButton(handler: () => boolean): void;
  /** Update status changes; the listener is called with the current status straight away. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): void;
  /** Checks the stage's downloads for a newer app now. */
  checkForUpdates(): Promise<void>;
  /** `ready`: restarts into the update; `available`: opens its download in the system browser. */
  installUpdate(): Promise<void>;
}
