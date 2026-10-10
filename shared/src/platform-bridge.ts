// The contract between the web app and the desktop and mobile shells (types only).

/** A file the user is offered to save. */
export interface SaveFile {
  name: string;
  type: string;
  data: string;
}

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
  /** Matches system bars and window frames to the app's light or dark theme. */
  setDarkTheme(dark: boolean): Promise<void>;
  /**
   * Called on the system back button (Android); the handler returns false when it had nothing to
   * close or go back to, and the app then exits.
   */
  onBackButton(handler: () => boolean): void;
}
