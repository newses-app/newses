// The app's window: hardened, restored where it was, and kept on the app's own pages.
import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { currentOptions } from './options.ts';
import type { SettingsStore } from './settings.ts';
import { themeBackground, themeText } from './theme.ts';
import { APP_ORIGIN, externalUrl, isAppUrl } from './urls.ts';
import { centered, onScreen, restoreBounds } from './window-state.ts';

const DEFAULT_SIZE = { width: 1200, height: 800 };
/** Vuetify's compact app bar. */
export const TITLE_BAR_HEIGHT = 48;

const workAreas = () => screen.getAllDisplays().map((display) => display.workArea);

export interface WindowOptions {
  settings: SettingsStore;
  /** Started at login into the tray: shown only when asked for. */
  hidden: boolean;
  /**
   * No native title bar: the web app's app bar moves the window, and the window controls overlay
   * its end, transparent over it and drawn in the theme's text colour.
   */
  controlsOverlay: boolean;
  icon: string;
  preload: string;
  /** Set once quitting starts, so closing to the tray does not stop it. */
  quitting: () => boolean;
  onClosed: () => void;
  onFocus: () => void;
}

/** Opens a link to another site in the system browser; nothing else leaves the app. */
export function openExternally(url: string): void {
  const target = externalUrl(url);
  if (target) void shell.openExternal(target);
}

export function createWindow(options: WindowOptions): BrowserWindow {
  const { settings, hidden, controlsOverlay } = options;
  const saved = settings.get().window;
  const bounds = restoreBounds(saved, workAreas());
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    ...(bounds ?? centered(DEFAULT_SIZE, screen.getPrimaryDisplay().workArea)),
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Newses',
    autoHideMenuBar: true,
    backgroundColor: themeBackground(settings.get()) ?? (dark ? '#121212' : '#ffffff'),
    ...(controlsOverlay && {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: themeText(settings.get()) ?? (dark ? '#ffffff' : '#000000'),
        height: TITLE_BAR_HEIGHT,
      },
    }),
    icon: options.icon,
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [`--newses-version=${app.getVersion()}`],
    },
  });
  if (bounds && saved?.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });
  win.on('close', (event) => {
    // A minimized window, or one parked off-screen (WSLg), keeps the last bounds on a screen.
    const normal = win.getNormalBounds();
    if (!win.isMinimized() && onScreen(normal, workAreas()))
      void settings.update({ window: { ...normal, maximized: win.isMaximized() } });
    // The app keeps running, and checking for new entries, in the tray.
    if (!options.quitting() && currentOptions(settings).closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', options.onClosed);
  // Back at the window, the new entries are in front of the reader.
  win.on('focus', options.onFocus);

  // The app never navigates away from itself: links to other sites open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  void win.loadURL(`${APP_ORIGIN}/`);
  return win;
}
