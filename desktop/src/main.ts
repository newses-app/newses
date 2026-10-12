// The desktop app: the native web build in a hardened window, served from app://newses.
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { NATIVE_CSP } from '@newses/shared/web-csp';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { setLaunchAtLogin, setTray } from './background.ts';
import { DEFAULT_OPTIONS, HIDDEN_ARG, notificationTarget, parseOptions } from './options.ts';
import { openSettings, type SettingsStore } from './settings.ts';
import { createTokenStore } from './token.ts';
import { APP_ORIGIN, APP_SCHEME, appFilePath, externalUrl, httpsOrigin, isAppUrl } from './urls.ts';
import { themeSource } from './theme.ts';
import { startUpdater, type Updater } from './updater.ts';
import { centered, onScreen, restoreBounds } from './window-state.ts';

const APP_ID = 'app.newses';
const WEB_DIR = join(__dirname, 'web');
/** `pnpm dev`: pages come from the web app's Vite dev server, still on the app origin. */
const DEV_SERVER = app.isPackaged ? undefined : process.env.NEWSES_DEV_SERVER;
/** The bundled build's CSP, also sent as a header so it covers what a `<meta>` cannot. */
const CSP = `${NATIVE_CSP}; frame-ancestors 'none'`;
/** Renderer permissions the app uses: notifications, and copying share links. */
const PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

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
/** Shown notifications, kept until they close: one that is garbage collected loses its click. */
const notifications = new Set<Notification>();

const options = (settings: SettingsStore) => ({ ...DEFAULT_OPTIONS, ...settings.get().options });

const DEFAULT_SIZE = { width: 1200, height: 800 };
const workAreas = () => screen.getAllDisplays().map((display) => display.workArea);
const defaultBounds = () => centered(DEFAULT_SIZE, screen.getPrimaryDisplay().workArea);

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Asks the app to refresh its counters now. */
const refresh = () => window?.webContents.send('bridge:refresh');

function applyBackground(settings: SettingsStore) {
  setTray(options(settings).closeToTray, { open: showWindow, checkNow: refresh });
}

async function serveApp(request: Request): Promise<Response> {
  if (DEV_SERVER) {
    const { pathname, search } = new URL(request.url);
    return net.fetch(`${DEV_SERVER}${pathname}${search}`);
  }
  const file = appFilePath(WEB_DIR, request.url);
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('content-security-policy', CSP);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** Bridge calls are answered only for the app's own pages. */
function handle(channel: string, listener: (...args: unknown[]) => unknown) {
  ipcMain.handle(`bridge:${channel}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isAppUrl(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    return listener(...args);
  });
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max ? value : null;

function registerBridge(settings: SettingsStore) {
  const tokens = createTokenStore(settings, safeStorage, process.platform);
  handle('getServerUrl', () => settings.get().serverUrl ?? null);
  handle('setServerUrl', async (url) => {
    const origin = httpsOrigin(url);
    if (!origin) throw new Error('Not an HTTPS origin');
    await settings.update({ serverUrl: origin });
  });
  handle('getToken', () => tokens.get());
  handle('setToken', async (token) => {
    const value = text(token, 1024);
    if (!value) throw new Error('Invalid token');
    await tokens.set(value);
  });
  handle('clearToken', () => tokens.clear());
  handle('openExternal', async (url) => {
    const target = externalUrl(text(url, 8192) ?? '');
    if (target) await shell.openExternal(target);
  });
  handle('saveFile', async (file) => {
    const { name, data } = (file ?? {}) as { name?: unknown; data?: unknown };
    const fileName = text(name, 255);
    const contents = text(data, 50 * 1024 * 1024);
    if (!fileName || contents === null || !window) return false;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: join(app.getPath('downloads'), fileName),
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, contents);
    return true;
  });
  handle('notify', (value) => {
    const { title, body, target } = (value ?? {}) as Record<string, unknown>;
    if (!Notification.isSupported()) return;
    const path = notificationTarget(target);
    const notification = new Notification({
      title: text(title, 256) ?? '',
      body: text(body, 1024) ?? '',
    });
    notifications.add(notification);
    notification.on('click', () => {
      showWindow();
      if (path) window?.webContents.send('bridge:navigate', path);
    });
    notification.on('close', () => notifications.delete(notification));
    notification.show();
  });
  handle('getDesktopOptions', () => options(settings));
  handle('setDesktopOptions', async (value) => {
    const changes = parseOptions(value);
    if (!changes) throw new Error('Invalid options');
    await settings.update({ options: { ...settings.get().options, ...changes } });
    applyBackground(settings);
    if (changes.launchAtLogin !== undefined) await setLaunchAtLogin(changes.launchAtLogin);
  });
  // `system` lets Electron follow the OS again; pinning light or dark would stop that for good.
  handle('setTheme', (theme) => {
    nativeTheme.themeSource = themeSource(theme);
  });
  handle('getUpdateStatus', () => updater?.status() ?? { state: 'unsupported' });
  handle('checkForUpdates', () => updater?.check());
  handle('installUpdate', () => updater?.install());
}

function buildMenu() {
  const view: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  if (!app.isPackaged) view.push({ type: 'separator' }, { role: 'toggleDevTools' });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: view },
    ]),
  );
}

function openExternally(url: string) {
  const target = externalUrl(url);
  if (target) void shell.openExternal(target);
}

function createWindow(settings: SettingsStore, hidden: boolean) {
  const saved = settings.get().window;
  const bounds = restoreBounds(saved, workAreas());
  const win = new BrowserWindow({
    ...(bounds ?? defaultBounds()),
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Newses',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#ffffff',
    icon: join(__dirname, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
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
    if (!quitting && options(settings).closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    window = null;
  });

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
    protocol.handle(APP_SCHEME, serveApp);
    registerBridge(settings);
    buildMenu();
    // Started at login: straight to the tray, when there is one.
    const hidden = process.argv.includes(HIDDEN_ARG) && options(settings).closeToTray;
    window = createWindow(settings, hidden);
    applyBackground(settings);
    // Re-registered, so a moved AppImage or a reinstall still starts at login.
    if (options(settings).launchAtLogin) void setLaunchAtLogin(true);
    powerMonitor.on('resume', refresh);
    powerMonitor.on('unlock-screen', refresh);
    updater = startUpdater((status) => {
      window?.webContents.send('bridge:updateStatus', status);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
