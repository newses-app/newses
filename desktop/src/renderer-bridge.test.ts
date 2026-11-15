import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '@newses/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBridge } from './ipc.ts';
import { type BridgePage, createDesktopBridge, type RendererIpc } from './renderer-bridge.ts';
import { openSettings } from './settings.ts';
import { ipcMain, resetElectron } from './test/electron.ts';

vi.mock('electron', () => import('./test/electron.ts'));

/** `ipcRenderer` with the main process answering each method with `answers[method]`. */
class FakeIpc implements RendererIpc {
  readonly calls: unknown[][] = [];
  readonly answers: Record<string, unknown> = {};
  readonly #listeners = new Map<string, ((event: unknown, value: unknown) => void)[]>();

  invoke(channel: string, ...args: unknown[]) {
    this.calls.push([channel, ...args]);
    return Promise.resolve(this.answers[channel.replace('bridge:', '')]);
  }

  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
    const listeners = this.#listeners.get(channel) ?? [];
    listeners.push(listener);
    this.#listeners.set(channel, listeners);
    return this;
  }

  /** The main process sending `channel` to the window. */
  send(channel: string, value?: unknown) {
    for (const listener of this.#listeners.get(channel) ?? []) listener({}, value);
  }
}

class FakePage implements BridgePage {
  argv = ['electron', '.', '--newses-version=1.4.0'];
  navigator = { onLine: true };
  readonly listeners = new Set<string>();
  readonly #handlers = new Map<string, () => void>();
  readonly window = {
    addEventListener: (type: string, listener: () => void) => {
      this.listeners.add(type);
      this.#handlers.set(type, listener);
    },
    removeEventListener: (type: string) => {
      this.listeners.delete(type);
    },
  };

  /** The browser's network going away or coming back. */
  setOnline(online: boolean) {
    this.navigator.onLine = online;
    this.#handlers.get(online ? 'online' : 'offline')?.();
  }
}

let ipc: FakeIpc;
let page: FakePage;

beforeEach(() => {
  ipc = new FakeIpc();
  page = new FakePage();
});

describe('createDesktopBridge', () => {
  it("is the desktop's, at the version the main process passes", () => {
    const bridge = createDesktopBridge(ipc, page);
    expect(bridge.platform).toBe('desktop');
    expect(bridge.appVersion).toBe('1.4.0');
    page.argv = ['electron', '.'];
    expect(createDesktopBridge(ipc, page).appVersion).toBe('');
  });

  it('asks the main process for what it keeps, with each argument', async () => {
    const bridge = createDesktopBridge(ipc, page);
    ipc.answers.getToken = 'token';
    ipc.answers.saveFile = true;
    ipc.answers.shareLink = true;
    expect(await bridge.getToken()).toBe('token');
    await bridge.setToken('new');
    await bridge.updateProfile('p1', { label: 'Work' });
    expect(await bridge.saveFile({ name: 'a.opml', type: 'text/x-opml', data: '<opml/>' })).toBe(
      true,
    );
    const link = { title: 'Big story', text: '', url: 'https://news.example/a' };
    expect(await bridge.shareLink(link)).toBe(true);
    await bridge.setTheme({
      preference: 'dark',
      dark: true,
      background: '#000000',
      text: '#ffffff',
    });
    await bridge.setLanguage('fr');
    expect(ipc.calls).toEqual([
      ['bridge:getToken'],
      ['bridge:setToken', 'new'],
      ['bridge:updateProfile', 'p1', { label: 'Work' }],
      ['bridge:saveFile', { name: 'a.opml', type: 'text/x-opml', data: '<opml/>' }],
      ['bridge:shareLink', link],
      [
        'bridge:setTheme',
        { preference: 'dark', dark: true, background: '#000000', text: '#ffffff' },
      ],
      ['bridge:setLanguage', 'fr'],
    ]);
  });

  it('passes what the main process sends to the latest handler', () => {
    const bridge = createDesktopBridge(ipc, page);
    ipc.send('bridge:navigate', '/f7');
    const first = vi.fn();
    const latest = vi.fn();
    bridge.onNavigate(first);
    bridge.onNavigate(latest);
    ipc.send('bridge:navigate', '/c4');
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith('/c4');

    const selected = vi.fn();
    bridge.onProfileSelected(selected);
    ipc.send('bridge:selectProfile', 'p2');
    expect(selected).toHaveBeenCalledWith('p2');
  });

  it('tells every refresh listener until it stops listening', () => {
    const bridge = createDesktopBridge(ipc, page);
    const [one, two] = [vi.fn(), vi.fn()];
    const stopOne = bridge.onRefresh(one);
    bridge.onRefresh(two);
    ipc.send('bridge:refresh');
    stopOne();
    ipc.send('bridge:refresh');
    expect(one).toHaveBeenCalledOnce();
    expect(two).toHaveBeenCalledTimes(2);
  });

  it('reports whether there is a network, not which kind, as it changes', async () => {
    const bridge = createDesktopBridge(ipc, page);
    expect(await bridge.getNetwork()).toEqual({ connected: true, wifi: null });
    const changes = vi.fn();
    const stop = bridge.onNetworkChange(changes);
    page.setOnline(false);
    expect(changes).toHaveBeenCalledWith({ connected: false, wifi: null });
    stop();
    expect(page.listeners.size).toBe(0);
  });

  it('gives the update status now and as it changes', async () => {
    const bridge = createDesktopBridge(ipc, page);
    const idle: UpdateStatus = { state: 'idle' };
    ipc.answers.getUpdateStatus = idle;
    const statuses = vi.fn();
    bridge.onUpdateStatus(statuses);
    await vi.waitFor(() => {
      expect(statuses).toHaveBeenCalledWith(idle);
    });
    ipc.send('bridge:updateStatus', { state: 'checking' });
    expect(statuses).toHaveBeenLastCalledWith({ state: 'checking' });
  });

  it('leaves what the desktop does not do as no-ops', async () => {
    const bridge = createDesktopBridge(ipc, page);
    expect(await bridge.notificationAccess(true)).toBe('granted');
    expect(await bridge.takeBackgroundSync()).toEqual([]);
    expect(await bridge.pushStatus()).toEqual({ state: 'unsupported' });
    expect(await bridge.choosePushService()).toEqual({ state: 'unsupported' });
    await bridge.setBackgroundSync({ enabled: true, wifiOnly: false, syncToken: null });
    bridge.onShare(() => undefined);
    bridge.onBackButton(() => false);
    expect(ipc.calls).toEqual([]);
  });
});

describe('the bridge and the main process', () => {
  it('only calls channels the main process answers', async () => {
    resetElectron();
    const dir = await mkdtemp(join(tmpdir(), 'newses-bridge-'));
    try {
      registerBridge({
        settings: await openSettings(join(dir, 'settings.json')),
        portable: false,
        controlsOverlay: false,
        window: () => null,
        updater: () => null,
        showWindow: () => undefined,
        buildMenu: () => undefined,
        applyTray: () => undefined,
      });
      const bridge = createDesktopBridge(ipc, page);
      await Promise.all([
        bridge.getProfiles(),
        bridge.addProfile('https://reader.example'),
        bridge.updateProfile('p1', { label: 'Work' }),
        bridge.setActiveProfile('p1'),
        bridge.removeProfile('p1'),
        bridge.getToken(),
        bridge.setToken('token'),
        bridge.clearToken(),
        bridge.openExternal('https://blog.example/'),
        bridge.saveFile({ name: 'a.opml', type: 'text/x-opml', data: '<opml/>' }),
        bridge.shareLink({ title: 'A', text: '', url: 'https://news.example/a' }),
        bridge.notify({ title: 'Blog', body: '2 new', target: '/f7' }),
        bridge.getDesktopOptions(),
        bridge.setDesktopOptions({ closeToTray: true }),
        bridge.setTheme({ preference: 'dark', dark: true, background: '#000000', text: '#ffffff' }),
        bridge.setLanguage('fr'),
        bridge.checkForUpdates(),
        bridge.installUpdate(),
      ]);
      bridge.onUpdateStatus(() => undefined);
      const channels = ipc.calls.map(([channel]) => channel);
      expect(channels).toHaveLength(19);
      expect(channels.filter((channel) => !ipcMain.handlers.has(channel as string))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
