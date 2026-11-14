import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSettings, type Settings, type SettingsStore } from './settings.ts';
import { BrowserWindow, nativeTheme, resetElectron, shell } from './test/electron.ts';
import { createWindow, TITLE_BAR_HEIGHT, type WindowOptions } from './window.ts';

vi.mock('electron', () => import('./test/electron.ts'));

let dir: string;
let quitting: boolean;

async function open(saved: Settings = {}, options: Partial<WindowOptions> = {}) {
  const settings: SettingsStore = await openSettings(join(dir, 'settings.json'));
  await settings.update(saved);
  const onClosed = vi.fn();
  const onFocus = vi.fn();
  createWindow({
    settings,
    hidden: false,
    controlsOverlay: true,
    icon: '/opt/Newses/icon.png',
    preload: '/opt/Newses/preload.cjs',
    quitting: () => quitting,
    onClosed,
    onFocus,
    ...options,
  });
  const win = BrowserWindow.created.at(-1) as BrowserWindow;
  /** Closes the window as the reader would; returns whether closing went ahead. */
  const close = async () => {
    let prevented = false;
    win.emit('close', {
      preventDefault: () => {
        prevented = true;
      },
    });
    // Writes are serialised: this one waits for the bounds to be saved.
    await settings.update({});
    return !prevented;
  };
  return { settings, win, close, onClosed, onFocus };
}

/** Fires a navigation event; returns whether the window went ahead with it. */
function navigate(win: BrowserWindow, event: string, url: string) {
  let prevented = false;
  win.webContents.emit(event, { preventDefault: () => (prevented = true) }, url);
  return !prevented;
}

beforeEach(async () => {
  resetElectron();
  quitting = false;
  dir = await mkdtemp(join(tmpdir(), 'newses-window-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createWindow', () => {
  it('opens a hardened window on the app, centred on first run', async () => {
    const { win } = await open();
    expect(win.options).toMatchObject({
      x: 360,
      y: 140,
      width: 1200,
      height: 800,
      show: false,
      backgroundColor: '#ffffff',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#000000', height: TITLE_BAR_HEIGHT },
      icon: '/opt/Newses/icon.png',
      webPreferences: {
        preload: '/opt/Newses/preload.cjs',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        additionalArguments: ['--newses-version=1.2.3'],
      },
    });
    expect(win.url).toBe('app://newses/');
    expect(win.visible).toBe(false);
    win.emit('ready-to-show');
    expect(win.visible).toBe(true);
  });

  it("restores where it was, in the theme's colours, and stays hidden when started so", async () => {
    nativeTheme.shouldUseDarkColors = true;
    const { win } = await open(
      { window: { x: 10, y: 20, width: 900, height: 700, maximized: true } },
      { hidden: true, controlsOverlay: false },
    );
    expect(win.options).toMatchObject({ x: 10, y: 20, width: 900, height: 700 });
    expect(win.options).toMatchObject({ backgroundColor: '#121212' });
    expect(win.options).not.toHaveProperty('titleBarOverlay');
    expect(win.maximized).toBe(true);
    win.emit('ready-to-show');
    expect(win.visible).toBe(false);

    const themed = await open({ background: '#202020', text: '#eeeeee' });
    expect(themed.win.options).toMatchObject({
      backgroundColor: '#202020',
      titleBarOverlay: { symbolColor: '#eeeeee' },
    });
  });

  it('keeps its bounds on close, but not when minimized or off-screen', async () => {
    const { win, close, settings } = await open();
    win.bounds = { x: 50, y: 60, width: 1000, height: 700 };
    win.maximized = true;
    expect(await close()).toBe(true);
    expect(settings.get().window).toEqual({
      x: 50,
      y: 60,
      width: 1000,
      height: 700,
      maximized: true,
    });

    win.bounds = { x: -5000, y: -5000, width: 1000, height: 700 };
    await close();
    win.minimized = true;
    win.bounds = { x: 0, y: 0, width: 800, height: 600 };
    await close();
    expect(settings.get().window?.x).toBe(50);
  });

  it('hides to the tray on close while that is on, unless quitting', async () => {
    const { win, close, onClosed } = await open({ options: { closeToTray: true } });
    win.visible = true;
    expect(await close()).toBe(false);
    expect(win.visible).toBe(false);
    quitting = true;
    expect(await close()).toBe(true);
    win.emit('closed');
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('tells the app when it has focus', async () => {
    const { win, onFocus } = await open();
    win.emit('focus');
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it('never leaves the app: other sites open in the browser, and nothing else', async () => {
    const { win } = await open();
    expect(navigate(win, 'will-navigate', 'app://newses/settings')).toBe(true);
    expect(navigate(win, 'will-navigate', 'https://example.com/post')).toBe(false);
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/post');
    expect(navigate(win, 'will-navigate', 'file:///etc/passwd')).toBe(false);
    expect(shell.openExternal).toHaveBeenCalledOnce();

    expect(navigate(win, 'will-redirect', 'app://newses/all')).toBe(true);
    expect(navigate(win, 'will-redirect', 'https://example.com/')).toBe(false);

    expect(win.webContents.openHandler?.({ url: 'https://example.com/a' })).toEqual({
      action: 'deny',
    });
    expect(win.webContents.openHandler?.({ url: 'javascript:alert(1)' })).toEqual({
      action: 'deny',
    });
    expect(shell.openExternal.mock.calls).toEqual([
      ['https://example.com/post'],
      ['https://example.com/a'],
    ]);
  });
});
