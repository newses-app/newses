// Electron's main-process APIs as the desktop modules use them, for tests:
//   vi.mock('electron', () => import('./test/electron.ts'));
// Each records what was done to it; `resetElectron()` starts over.
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

/** `ipcMain`: the handlers registered, by channel. */
export const ipcMain = {
  handlers: new Map<string, Listener>(),
  handle(channel: string, listener: Listener) {
    this.handlers.set(channel, listener);
  },
};

export const app = {
  isPackaged: true,
  getVersion: () => '1.2.3',
  getName: () => 'Newses',
  getPath: vi.fn((name: string) => `/home/reader/${name}`),
  quit: vi.fn(),
  setLoginItemSettings: vi.fn(),
};

export const shell = {
  openExternal: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
  openPath: vi.fn<(path: string) => Promise<string>>(() => Promise.resolve('')),
};

export const dialog = {
  showSaveDialog: vi.fn<
    (
      window: unknown,
      options: { defaultPath: string },
    ) => Promise<{ canceled: boolean; filePath: string | undefined }>
  >(() => Promise.resolve({ canceled: false, filePath: '' })),
};

export const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false };

export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (data: Buffer) => data.toString().slice(4),
};

export const net = {
  fetch: vi.fn<(url: string) => Promise<Response>>(() => Promise.resolve(new Response(''))),
};

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };
export const screen = {
  getAllDisplays: () => [{ workArea: WORK_AREA }],
  getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
};

export class Notification extends EventEmitter {
  static isSupported = vi.fn(() => true);
  static shown: Notification[] = [];
  readonly show = vi.fn(() => {
    Notification.shown.push(this);
  });
  readonly close = vi.fn();

  readonly options: { title: string; body: string };

  constructor(options: { title: string; body: string }) {
    super();
    this.options = options;
  }
}

/** A web page's events, and what was sent to it. */
class WebContents extends EventEmitter {
  readonly sent: unknown[][] = [];
  openHandler: ((details: { url: string }) => { action: string }) | null = null;

  send(...args: unknown[]) {
    this.sent.push(args);
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.openHandler = handler;
  }
}

export class BrowserWindow extends EventEmitter {
  static created: BrowserWindow[] = [];
  readonly webContents = new WebContents();
  bounds = { x: 100, y: 100, width: 1200, height: 800 };
  minimized = false;
  maximized = false;
  visible = false;
  url = '';
  readonly setBackgroundColor = vi.fn();
  readonly setTitleBarOverlay = vi.fn();

  readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    BrowserWindow.created.push(this);
  }

  getNormalBounds() {
    return this.bounds;
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return this.maximized;
  }
  maximize() {
    this.maximized = true;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  loadURL(url: string) {
    this.url = url;
    return Promise.resolve();
  }
}

export class Tray extends EventEmitter {
  static created: Tray[] = [];
  menu: unknown = null;
  tooltip = '';
  destroyed = false;

  readonly icon: unknown;

  constructor(icon: unknown) {
    super();
    this.icon = icon;
    Tray.created.push(this);
  }

  setToolTip(text: string) {
    this.tooltip = text;
  }
  setContextMenu(menu: unknown) {
    this.menu = menu;
  }
  destroy() {
    this.destroyed = true;
  }
}

/** Menus are their templates. */
export const Menu = { buildFromTemplate: (template: unknown) => template };

export const nativeImage = {
  createFromPath: (path: string) => ({ path, resize: (size: object) => ({ path, size }) }),
};

/** Starts every fake over. */
export function resetElectron(): void {
  ipcMain.handlers.clear();
  BrowserWindow.created = [];
  Tray.created = [];
  Notification.shown = [];
  Notification.isSupported.mockReturnValue(true);
  nativeTheme.themeSource = 'system';
  nativeTheme.shouldUseDarkColors = false;
  app.isPackaged = true;
  vi.clearAllMocks();
  app.getPath.mockImplementation((name: string) => `/home/reader/${name}`);
}
