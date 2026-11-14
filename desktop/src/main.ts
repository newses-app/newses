// The desktop app: the native web build in a hardened window (window.ts), served from app://newses
// (serve.ts), answering the bridge (ipc.ts).
import { dirname, join } from 'node:path';
import type { ProfileList } from '@newses/shared';
import { NATIVE_CSP } from '@newses/shared/web-csp';
import { app, type BrowserWindow, Menu, powerMonitor, protocol, session, shell } from 'electron';
import { appMenu } from './app-menu.ts';
import { setLaunchAtLogin, setTray } from './background.ts';
import { setLanguage } from './i18n.ts';
import { registerBridge } from './ipc.ts';
import { closeShown } from './notifications.ts';
import { currentOptions, HIDDEN_ARG } from './options.ts';
import { portableDataDir, usableDataDir } from './portable.ts';
import { serveApp } from './serve.ts';
import { openSettings, type SettingsStore } from './settings.ts';
import { APP_SCHEME } from './urls.ts';
import { startUpdater, type Updater } from './updater.ts';
import { createWindow } from './window.ts';

const APP_ID = 'app.newses';
const WEB_DIR = join(__dirname, 'web');
/** `pnpm dev`: pages come from the web app's Vite dev server, still on the app origin. */
const DEV_SERVER = app.isPackaged ? undefined : process.env.NEWSES_DEV_SERVER;
/** The bundled build's CSP, also sent as a header so it covers what a `<meta>` cannot. */
const CSP = `${NATIVE_CSP}; frame-ancestors 'none'`;
/** Renderer permissions the app uses: notifications, and copying share links. */
const PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);
/**
 * No native title bar: the web app's app bar moves the window, and the window controls overlay its
 * end, transparent over it and drawn in the theme's text colour.
 */
const CONTROLS_OVERLAY = process.platform === 'win32' || process.platform === 'linux';

/** The Windows portable exe: its data folder beside it, or null for any other install. */
const PORTABLE_DATA = portableDataDir(process.env, process.platform);
const PORTABLE = PORTABLE_DATA !== null;
// Before the single-instance lock, which, like every path the app keeps data in, follows userData.
// A read-only folder leaves the data in the user's profile, as for the zip.
if (PORTABLE_DATA && usableDataDir(PORTABLE_DATA)) app.setPath('userData', PORTABLE_DATA);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let window: BrowserWindow | null = null;
let updater: Updater | null = null;
/** Set once quitting starts, so closing to the tray does not stop it. */
let quitting = false;

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Asks the app to refresh its counters now. */
const refresh = () => window?.webContents.send('bridge:refresh');

const trayActions = {
  open: showWindow,
  checkNow: refresh,
  /** The app moves there itself, after any sync in progress. */
  selectProfile: (id: string) => {
    showWindow();
    window?.webContents.send('bridge:selectProfile', id);
  },
};

function applyTray(settings: SettingsStore, profiles?: ProfileList) {
  setTray(currentOptions(settings).closeToTray, trayActions, profiles);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenu({
        developer: !app.isPackaged,
        windows: process.platform === 'win32',
        about: () => {
          showWindow();
          // Signed in, the app shows Settings → About instead.
          window?.webContents.send('bridge:navigate', '/about');
        },
        // electron-builder puts it beside the executable, as Electron's own dist has it.
        chromiumLicenses: () =>
          void shell.openPath(join(dirname(process.execPath), 'LICENSES.chromium.html')),
      }),
    ),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });

  void app.whenReady().then(async () => {
    const settings = await openSettings(join(app.getPath('userData'), 'settings.json'));
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(PERMISSIONS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
      PERMISSIONS.has(permission),
    );
    protocol.handle(APP_SCHEME, serveApp({ webDir: WEB_DIR, csp: CSP, devServer: DEV_SERVER }));
    const showProfiles = registerBridge({
      settings,
      portable: PORTABLE,
      controlsOverlay: CONTROLS_OVERLAY,
      window: () => window,
      updater: () => updater,
      showWindow,
      buildMenu,
      applyTray: (profiles) => {
        applyTray(settings, profiles);
      },
    });
    const { language } = settings.get();
    setLanguage([...(language ? [language] : []), ...app.getPreferredSystemLanguages()]);
    buildMenu();
    // Started at login: straight to the tray, when there is one.
    window = createWindow({
      settings,
      hidden: process.argv.includes(HIDDEN_ARG) && currentOptions(settings).closeToTray,
      controlsOverlay: CONTROLS_OVERLAY,
      icon: join(__dirname, 'icon.png'),
      preload: join(__dirname, 'preload.cjs'),
      quitting: () => quitting,
      onClosed: () => {
        window = null;
      },
      onFocus: closeShown,
    });
    applyTray(settings);
    void showProfiles();
    // Re-registered, so a moved AppImage or a reinstall still starts at login.
    if (!PORTABLE && currentOptions(settings).launchAtLogin) void setLaunchAtLogin(true);
    powerMonitor.on('resume', refresh);
    powerMonitor.on('unlock-screen', refresh);
    updater = startUpdater((status) => {
      window?.webContents.send('bridge:updateStatus', status);
    }, PORTABLE);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
