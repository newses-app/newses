// The contract between the web app and the desktop and mobile shells (types only).

/** A file the user is offered to save. */
export interface SaveFile {
  name: string;
  type: string;
  data: string;
}

/** A system notification; clicking it opens `target` (an app path, e.g. a feed's stream). */
export interface AppNotification {
  title: string;
  body: string;
  target?: string;
}

/** Desktop-only behaviour, kept by the shell. */
export interface DesktopOptions {
  /** Notify about new entries while the window is in the background. */
  notifications: boolean;
  /** Closing the window keeps the app in the tray. */
  closeToTray: boolean;
  /** Starts with the user's session (in the tray when `closeToTray`). */
  launchAtLogin: boolean;
}

/** The device's network as the OS sees it; the server may still be unreachable over it. */
export interface NetworkStatus {
  connected: boolean;
  /** On Wi-Fi rather than mobile data; null where the platform cannot tell. */
  wifi: boolean | null;
}

export interface AppTheme {
  preference: 'system' | 'light' | 'dark';
  /** Whether the background is dark, so text and icons over it should be light. */
  dark: boolean;
  /** The appearance theme's background, `#rrggbb`. */
  background: string;
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
  notify(notification: AppNotification): Promise<void>;
  /** Called with a clicked notification's target (desktop); replaces the previous handler. */
  onNavigate(handler: (target: string) => void): void;
  /**
   * Adds a listener for when server data should be refreshed now: after the computer resumes or
   * unlocks, or from the tray (desktop); when the app returns to the foreground (Android). Returns a
   * function that removes it.
   */
  onRefresh(listener: () => void): () => void;
  getNetwork(): Promise<NetworkStatus>;
  /** Adds a listener for network changes; returns a function that removes it. */
  onNetworkChange(listener: (status: NetworkStatus) => void): () => void;
  /** Null outside the desktop app. */
  getDesktopOptions(): Promise<DesktopOptions | null>;
  setDesktopOptions(options: Partial<DesktopOptions>): Promise<void>;
  /**
   * Called with text shared to the app from another app (Android's share sheet), including a share
   * that launched it; replaces the previous handler.
   */
  onShare(handler: (text: string) => void): void;
  /**
   * The app's theme: the reader's mode preference and its background now. Desktop follows the
   * preference (so `system` keeps tracking the OS) and paints its window with the background;
   * Android colours its system bar icons by `dark`.
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
