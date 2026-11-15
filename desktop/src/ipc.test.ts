import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileList, UpdateStatus } from '@newses/shared';
import type { BrowserWindow as ElectronWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BridgeHost, registerBridge } from './ipc.ts';
import { openSettings, type SettingsStore } from './settings.ts';
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  resetElectron,
  shell,
} from './test/electron.ts';
import type { Updater } from './updater.ts';

const setLaunchAtLogin = vi.hoisted(() =>
  vi.fn<(enabled: boolean) => Promise<void>>(() => Promise.resolve()),
);
vi.mock('electron', () => import('./test/electron.ts'));
vi.mock('./background.ts', () => ({ setLaunchAtLogin }));

let dir: string;
let settings: SettingsStore;
let window: BrowserWindow | null;
let updater: Updater | null;
let host: BridgeHost;
let applyTray: ReturnType<typeof vi.fn<(profiles?: ProfileList) => void>>;

/** Calls a bridge channel as a page at `url` would. */
const call = (channel: string, ...args: unknown[]) => from('app://newses/all', channel, ...args);
function from(url: string | undefined, channel: string, ...args: unknown[]) {
  const handler = ipcMain.handlers.get(`bridge:${channel}`);
  if (!handler) throw new Error(`No handler for ${channel}`);
  // As ipcMain answers: a handler that throws rejects the call.
  return Promise.resolve().then(() =>
    handler(url === undefined ? {} : { senderFrame: { url } }, ...args),
  );
}

/** Lets the tray updates that follow a change run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(options: Partial<BridgeHost> = {}) {
  settings = await openSettings(join(dir, 'settings.json'));
  applyTray = vi.fn();
  host = {
    settings,
    portable: false,
    controlsOverlay: true,
    // The fake stands in for Electron's window.
    window: () => window as unknown as ElectronWindow | null,
    updater: () => updater,
    showWindow: vi.fn(),
    buildMenu: vi.fn(),
    applyTray,
    ...options,
  };
  return registerBridge(host);
}

beforeEach(async () => {
  resetElectron();
  dir = await mkdtemp(join(tmpdir(), 'newses-ipc-'));
  window = new BrowserWindow({});
  updater = null;
});

afterEach(async () => {
  await settings.update({});
  await rm(dir, { recursive: true, force: true });
});

describe('registerBridge', () => {
  it("answers only the app's own pages", async () => {
    await setup();
    await expect(from('https://evil.example/', 'getProfiles')).rejects.toThrow('Not allowed');
    await expect(from('app://newsesx/', 'getProfiles')).rejects.toThrow('Not allowed');
    await expect(from(undefined, 'getProfiles')).rejects.toThrow('Not allowed');
    await expect(call('getProfiles')).resolves.toEqual({ profiles: [], active: null });
  });

  it('keeps profiles and their tokens, showing each change in the tray', async () => {
    const showProfiles = await setup();
    const { id } = (await call('addProfile', 'https://reader.example')) as { id: string };
    await call('setActiveProfile', id);
    await call('updateProfile', id, { login: 'ann' });
    await call('setToken', 'secret-token');
    await settle();
    expect(await call('getToken')).toBe('secret-token');
    const list = (await call('getProfiles')) as ProfileList;
    expect(list).toMatchObject({ active: id, profiles: [{ id, login: 'ann', signedIn: true }] });
    expect(applyTray).toHaveBeenLastCalledWith(list);
    // Encrypted with the OS key store, never in the clear.
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).not.toContain('secret-token');

    await call('clearToken');
    expect(await call('getToken')).toBeNull();
    await call('removeProfile', id);
    await settle();
    expect(applyTray).toHaveBeenLastCalledWith({ profiles: [], active: null });
    applyTray.mockClear();
    await showProfiles();
    expect(applyTray).toHaveBeenCalledOnce();
  });

  it('refuses profiles, changes, and tokens that are not what the shell keeps', async () => {
    await setup();
    await expect(call('addProfile', 'http://reader.example')).rejects.toThrow('Invalid server');
    await expect(call('setActiveProfile', '../x')).rejects.toThrow('Invalid profile');
    await expect(call('removeProfile', 42)).rejects.toThrow('Invalid profile');
    const { id } = (await call('addProfile', 'https://reader.example')) as { id: string };
    await expect(call('updateProfile', id, { serverUrl: 'https://x.example' })).rejects.toThrow(
      'Invalid changes',
    );
    await expect(call('setToken', 'x'.repeat(1025))).rejects.toThrow('Invalid token');
  });

  it('opens web links in the browser, and nothing else', async () => {
    await setup();
    await call('openExternal', 'https://example.com/post');
    await call('openExternal', 'file:///etc/passwd');
    await call('openExternal', `https://example.com/${'a'.repeat(8192)}`);
    await call('openExternal', 42);
    expect(shell.openExternal.mock.calls).toEqual([['https://example.com/post']]);
  });

  it('opens a new mail with a shared link, and only that', async () => {
    await setup();
    const link = { title: 'Big story', text: 'Look', url: 'https://news.example/a' };
    await expect(call('shareLink', link)).resolves.toBe(true);
    expect(shell.openExternal.mock.calls).toEqual([
      ['mailto:?subject=Big%20story&body=Look%0D%0A%0D%0Ahttps%3A%2F%2Fnews.example%2Fa'],
    ]);
    await expect(call('shareLink', { ...link, url: 'file:///etc/passwd' })).rejects.toThrow(
      'Invalid link',
    );
    await expect(call('shareLink', { ...link, url: 'mailto:someone@example.com' })).rejects.toThrow(
      'Invalid link',
    );
    await expect(call('shareLink', { ...link, title: 'x'.repeat(301) })).rejects.toThrow(
      'Invalid title',
    );
    await expect(call('shareLink', { ...link, text: 42 })).rejects.toThrow('Invalid text');
    await expect(call('shareLink', null)).rejects.toThrow('Invalid title');
    expect(shell.openExternal).toHaveBeenCalledOnce();
  });

  it('saves a file where the reader picks, starting in their downloads', async () => {
    await setup();
    const target = join(dir, 'export.opml');
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    await expect(call('saveFile', { name: 'export.opml', data: '<opml/>' })).resolves.toBe(true);
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(window, {
      defaultPath: join('/home/reader/downloads', 'export.opml'),
    });
    expect(await readFile(target, 'utf8')).toBe('<opml/>');

    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined });
    await expect(call('saveFile', { name: 'a.opml', data: '' })).resolves.toBe(false);
    await expect(call('saveFile', { name: 'x'.repeat(256), data: '' })).resolves.toBe(false);
    await expect(call('saveFile', { name: 'a.opml', data: 42 })).resolves.toBe(false);
    await expect(call('saveFile', null)).resolves.toBe(false);
    window = null;
    await expect(call('saveFile', { name: 'a.opml', data: '' })).resolves.toBe(false);
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(2);
  });

  it('notifies of new entries, replacing the last notification, and opens their stream', async () => {
    await setup();
    await settings.update({ activeProfile: 'p1' });
    await call('notify', { title: '2 new entries', body: 'News', target: '/c/3' });
    await call('notify', { title: '3 new entries', body: 'News', target: '/c/3' });
    const [first, second] = Notification.shown;
    expect(first?.close).toHaveBeenCalledOnce();
    expect(second?.options).toEqual({ title: '3 new entries', body: 'News' });

    second?.emit('click');
    expect(host.showWindow).toHaveBeenCalledOnce();
    expect(window?.webContents.sent).toEqual([['bridge:navigate', '/c/3']]);

    // Another profile's stream is not this one's: the click only opens the app.
    await settings.update({ activeProfile: 'p2' });
    second?.emit('click');
    expect(window?.webContents.sent).toHaveLength(1);
  });

  it('opens nothing from a notification whose target could leave the app', async () => {
    await setup();
    await call('notify', { title: 7, body: 'x'.repeat(1025), target: 'https://evil.example' });
    const [shown] = Notification.shown;
    expect(shown?.options).toEqual({ title: '', body: '' });
    shown?.emit('click');
    expect(window?.webContents.sent).toEqual([]);

    Notification.isSupported.mockReturnValue(false);
    await call('notify', { title: 'Hi', body: '', target: '/all' });
    expect(Notification.shown).toHaveLength(1);
  });

  it('changes the desktop options it offers, applying the tray and login item', async () => {
    await setup();
    expect(await call('getDesktopOptions')).toEqual({
      notifications: true,
      closeToTray: false,
      launchAtLogin: false,
    });
    await call('setDesktopOptions', { closeToTray: true });
    expect(settings.get().options).toEqual({ closeToTray: true });
    expect(applyTray).toHaveBeenCalledWith();
    expect(setLaunchAtLogin).not.toHaveBeenCalled();
    await call('setDesktopOptions', { launchAtLogin: true });
    expect(setLaunchAtLogin).toHaveBeenCalledWith(true);
    expect(settings.get().options).toEqual({ closeToTray: true, launchAtLogin: true });
    await expect(call('setDesktopOptions', { closeToTray: 'yes' })).rejects.toThrow(
      'Invalid options',
    );
  });

  it('offers no launch at login in the portable exe', async () => {
    await setup({ portable: true });
    expect(await call('getDesktopOptions')).toEqual({ notifications: true, closeToTray: false });
    await expect(call('setDesktopOptions', { launchAtLogin: true })).rejects.toThrow(
      'Invalid options',
    );
  });

  it("follows the app's language in its menus", async () => {
    await setup();
    await call('setLanguage', 42);
    await call('setLanguage', 'de');
    await settle();
    expect(settings.get().language).toBe('de');
    expect(host.buildMenu).toHaveBeenCalledOnce();
    await call('setLanguage', 'de-AT');
    expect(host.buildMenu).toHaveBeenCalledOnce();
    await call('setLanguage', 'en');
  });

  it("follows the app's theme, and remembers its colours for the next window", async () => {
    await setup();
    await call('setTheme', { preference: 'dark', background: '#101010', text: '#eeeeee' });
    expect(nativeTheme.themeSource).toBe('dark');
    expect(window?.setBackgroundColor).toHaveBeenCalledWith('#101010');
    expect(window?.setTitleBarOverlay).toHaveBeenCalledWith({ symbolColor: '#eeeeee' });
    expect(settings.get()).toMatchObject({ background: '#101010', text: '#eeeeee' });

    const update = vi.spyOn(settings, 'update');
    await call('setTheme', { preference: 'system', background: '#101010', text: '#eeeeee' });
    await call('setTheme', { preference: 'light', background: 'red', text: null });
    expect(nativeTheme.themeSource).toBe('light');
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves the window controls alone without the overlay', async () => {
    await setup({ controlsOverlay: false });
    await call('setTheme', { text: '#eeeeee' });
    expect(window?.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(settings.get().text).toBe('#eeeeee');
  });

  it('reports updates as unsupported without an updater, and passes calls to one', async () => {
    await setup();
    expect(await call('getUpdateStatus')).toEqual({ state: 'unsupported' });
    await expect(call('checkForUpdates')).resolves.toBeUndefined();
    const status: UpdateStatus = { state: 'available', version: '1.3.0' };
    const check = vi.fn(() => Promise.resolve());
    const install = vi.fn(() => Promise.resolve());
    updater = { status: () => status, check, install };
    expect(await call('getUpdateStatus')).toBe(status);
    await call('checkForUpdates');
    await call('installUpdate');
    expect(check).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
  });
});
