import type { NetworkStatus, UpdateStatus } from '@newses/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AndroidPlugins, createAndroidBridge, UPDATE_CHECK_KEY } from './android-bridge.ts';
import { CHECK_INTERVAL_MS } from './updates.ts';

const DOWNLOADS = 'https://reader.example/downloads';
const NOW = 1_800_000_000_000;
const BUILD = 1_002_000;

const manifest = (versionCode: number) => ({
  version: '1.3.0',
  android: { url: `${DOWNLOADS}/1.3.0/app.apk`, size: 1, sha256: 'x', versionCode },
});

type Listener = (data: never) => void;

/** The plugins, keeping what they are given in memory; `emit` plays a plugin's event. */
function fakePlugins() {
  const listeners = new Map<string, Listener>();
  const listen = (prefix: string) => (event: string, listener: Listener) => {
    listeners.set(`${prefix}.${event}`, listener);
    return Promise.resolve({ remove: () => Promise.resolve() });
  };
  const preferences = new Map<string, string>();
  const secrets = new Map<string, string>();
  const fake = {
    app: {
      addListener: listen('app'),
      exitApp: vi.fn(() => Promise.resolve()),
      getInfo: () => Promise.resolve({ build: String(BUILD) }),
    },
    browser: { open: vi.fn(() => Promise.resolve()) },
    filesystem: {
      writeFile: vi.fn(() => Promise.resolve({ uri: 'file:///cache/export.opml' })),
    },
    http: {
      get: vi.fn<(options: object) => Promise<{ status: number; data: unknown }>>(() =>
        Promise.resolve({ status: 200, data: manifest(BUILD + 100) }),
      ),
    },
    network: {
      addListener: listen('network'),
      getStatus: () => Promise.resolve({ connected: true, connectionType: 'cellular' }),
    },
    preferences: {
      get: ({ key }: { key: string }) => Promise.resolve({ value: preferences.get(key) ?? null }),
      set: ({ key, value }: { key: string; value: string }) => {
        preferences.set(key, value);
        return Promise.resolve();
      },
      remove: ({ key }: { key: string }) => {
        preferences.delete(key);
        return Promise.resolve();
      },
    },
    secureStorage: {
      getItem: (key: string) => Promise.resolve(secrets.get(key) ?? null),
      setItem: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      removeItem: (key: string) => Promise.resolve(secrets.delete(key)),
    },
    share: { share: vi.fn(() => Promise.resolve({})) },
    systemBars: { setStyle: vi.fn(() => Promise.resolve()) },
    shareTarget: { addListener: listen('shareTarget') },
    backgroundSync: {
      addListener: listen('backgroundSync'),
      configure: vi.fn(() => Promise.resolve()),
      take: vi.fn(() => Promise.resolve({ pages: [{ seq: 1 }] })),
      notificationAccess: vi.fn(() => Promise.resolve({ state: 'granted' })),
      pushStatus: vi.fn(() => Promise.resolve({ state: 'none' })),
      choosePushService: vi.fn(() => Promise.resolve({ state: 'chosen' })),
    },
  };
  const emit = (event: string, data?: unknown) => listeners.get(event)?.(data as never);
  return { plugins: fake as unknown as AndroidPlugins, fake, emit, preferences, secrets };
}

function setup(
  downloadsUrl = DOWNLOADS,
  prepare?: (fakes: ReturnType<typeof fakePlugins>) => void,
) {
  const fakes = fakePlugins();
  prepare?.(fakes);
  const bridge = createAndroidBridge(fakes.plugins, { appVersion: '1.2.0', downloadsUrl });
  return { bridge, ...fakes };
}

/** Lets the launch check and other pending plugin calls finish. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAndroidBridge', () => {
  it('keeps profiles in Preferences and their tokens in secure storage', async () => {
    const { bridge, preferences, secrets } = setup('');
    expect(bridge).toMatchObject({ platform: 'android', appVersion: '1.2.0' });
    const { id } = await bridge.addProfile('https://reader.example');
    await bridge.setActiveProfile(id);
    await bridge.updateProfile(id, { login: 'ann' });
    await bridge.setToken('secret');
    expect(await bridge.getToken()).toBe('secret');
    expect(await bridge.getProfiles()).toMatchObject({ active: id, profiles: [{ login: 'ann' }] });
    expect([...preferences.values()].join()).not.toContain('secret');
    expect([...secrets.values()]).toContain('secret');
    await bridge.clearToken();
    expect(await bridge.getToken()).toBeNull();
    await bridge.removeProfile(id);
    expect(await bridge.getProfiles()).toEqual({ profiles: [], active: null });
  });

  it('hands the background job the active profile, and takes only its pages', async () => {
    const { bridge, fake } = setup('');
    const { id } = await bridge.addProfile('https://reader.example');
    await bridge.setActiveProfile(id);
    await bridge.setToken('secret');
    const options = { enabled: true, wifiOnly: true, syncToken: 's1' };
    await bridge.setBackgroundSync(options);
    expect(fake.backgroundSync.configure).toHaveBeenLastCalledWith({
      ...options,
      profileId: id,
      serverUrl: 'https://reader.example',
      token: 'secret',
    });
    await bridge.setBackgroundSync({ ...options, enabled: false });
    expect(fake.backgroundSync.configure).toHaveBeenLastCalledWith({
      ...options,
      enabled: false,
      profileId: null,
      serverUrl: null,
      token: null,
    });
    expect(await bridge.takeBackgroundSync()).toEqual([{ seq: 1 }]);
    expect(fake.backgroundSync.take).toHaveBeenCalledWith({ profileId: id });
    expect(await bridge.notificationAccess(true)).toBe('granted');
    expect(fake.backgroundSync.notificationAccess).toHaveBeenCalledWith({ ask: true });
    expect(await bridge.pushStatus()).toEqual({ state: 'none' });
    expect(await bridge.choosePushService()).toEqual({ state: 'chosen' });
  });

  it('hands over shares and notification taps that came before the app listened', () => {
    const { bridge, emit } = setup('');
    emit('shareTarget.share', { text: 'https://a.example/feed' });
    emit('backgroundSync.navigate', { target: '/c/2' });
    const shares: [string, string | null][] = [];
    bridge.onShare((text, subject) => shares.push([text, subject]));
    emit('shareTarget.share', { text: 'https://b.example', subject: 'B' });
    expect(shares).toEqual([
      ['https://a.example/feed', null],
      ['https://b.example', 'B'],
    ]);

    const targets: string[] = [];
    bridge.onNavigate((target) => targets.push(target));
    emit('backgroundSync.navigate', { target: '/all' });
    bridge.onNavigate((target) => targets.push(`again ${target}`));
    expect(targets).toEqual(['/c/2', '/all']);
  });

  it('refreshes on resume and follows the network, until unsubscribed', async () => {
    const { bridge, emit } = setup('');
    const refresh = vi.fn();
    const stop = bridge.onRefresh(refresh);
    emit('app.resume');
    stop();
    emit('app.resume');
    expect(refresh).toHaveBeenCalledOnce();

    expect(await bridge.getNetwork()).toEqual({ connected: true, wifi: false });
    const changes: NetworkStatus[] = [];
    const unsubscribe = bridge.onNetworkChange((status) => changes.push(status));
    emit('network.networkStatusChange', { connected: true, connectionType: 'wifi' });
    emit('network.networkStatusChange', { connected: false, connectionType: 'unknown' });
    unsubscribe();
    emit('network.networkStatusChange', { connected: true, connectionType: 'wifi' });
    expect(changes).toEqual([
      { connected: true, wifi: true },
      { connected: false, wifi: null },
    ]);
  });

  it("leaves the app on back unless the web app's handler takes it", () => {
    const { bridge, fake, emit } = setup('');
    emit('app.backButton');
    expect(fake.app.exitApp).toHaveBeenCalledOnce();
    let handled = true;
    bridge.onBackButton(() => handled);
    emit('app.backButton');
    expect(fake.app.exitApp).toHaveBeenCalledOnce();
    handled = false;
    emit('app.backButton');
    expect(fake.app.exitApp).toHaveBeenCalledTimes(2);
  });

  it('saves a file through the share sheet, and opens links in the browser', async () => {
    const { bridge, fake } = setup('');
    await expect(
      bridge.saveFile({ name: 'export.opml', type: 'text/x-opml', data: '<opml/>' }),
    ).resolves.toBe(true);
    expect(fake.filesystem.writeFile).toHaveBeenCalledWith({
      path: 'export.opml',
      data: '<opml/>',
      directory: 'CACHE',
      encoding: 'utf8',
    });
    expect(fake.share.share).toHaveBeenCalledWith({
      title: 'export.opml',
      files: ['file:///cache/export.opml'],
    });
    fake.share.share.mockRejectedValueOnce(new Error('Share canceled'));
    await expect(bridge.saveFile({ name: 'a.opml', type: 'text/x-opml', data: '' })).resolves.toBe(
      false,
    );

    await bridge.openExternal('https://example.com/');
    expect(fake.browser.open).toHaveBeenCalledWith({ url: 'https://example.com/' });
  });

  it('draws light bar icons over a dark theme, and dark ones over a light one', async () => {
    const { bridge, fake } = setup('');
    await bridge.setTheme({ dark: true } as Parameters<typeof bridge.setTheme>[0]);
    await bridge.setTheme({ dark: false } as Parameters<typeof bridge.setTheme>[0]);
    expect(fake.systemBars.setStyle.mock.calls).toEqual([
      [{ style: 'DARK' }],
      [{ style: 'LIGHT' }],
    ]);
  });

  it('leaves the desktop and notification calls empty', async () => {
    const { bridge } = setup('');
    expect(await bridge.getDesktopOptions()).toBeNull();
    await expect(bridge.setDesktopOptions({})).resolves.toBeUndefined();
    await expect(bridge.notify({ title: '', body: '', target: '/' })).resolves.toBeUndefined();
    await expect(bridge.setLanguage('de')).resolves.toBeUndefined();
    bridge.onProfileSelected(() => undefined);
  });
});

describe('updates', () => {
  const statuses = (bridge: ReturnType<typeof setup>['bridge']) => {
    const seen: UpdateStatus[] = [];
    bridge.onUpdateStatus((status) => seen.push(status));
    return seen;
  };

  it('never checks in a local build', async () => {
    const { bridge, fake } = setup('');
    const seen = statuses(bridge);
    await bridge.checkForUpdates();
    await settle();
    expect(seen).toEqual([{ state: 'unsupported' }]);
    expect(fake.http.get).not.toHaveBeenCalled();
  });

  it('checks at launch, remembers what it found, and installs it through the browser', async () => {
    const { bridge, fake, preferences } = setup();
    const seen = statuses(bridge);
    await settle();
    expect(fake.http.get).toHaveBeenCalledWith({
      url: `${DOWNLOADS}/latest.json`,
      responseType: 'json',
    });
    // A listener hears the status at once, then each change.
    expect(seen).toEqual([
      { state: 'idle' },
      { state: 'checking' },
      { state: 'available', version: '1.3.0' },
    ]);
    expect(JSON.parse(preferences.get(UPDATE_CHECK_KEY) ?? '')).toMatchObject({
      checkedAt: NOW,
      update: { versionCode: BUILD + 100 },
    });
    await bridge.installUpdate();
    expect(fake.browser.open).toHaveBeenCalledWith({ url: `${DOWNLOADS}/1.3.0/app.apk` });
  });

  it('uses the last check within a day, while it is still newer than the app', async () => {
    const record = (versionCode: number) =>
      JSON.stringify({
        checkedAt: NOW - 1000,
        update: { version: '1.3.0', versionCode, url: `${DOWNLOADS}/1.3.0/app.apk` },
      });
    const newer = setup(DOWNLOADS, ({ preferences }) => {
      preferences.set(UPDATE_CHECK_KEY, record(BUILD + 1));
    });
    await settle();
    expect(newer.fake.http.get).not.toHaveBeenCalled();
    expect(statuses(newer.bridge)).toEqual([{ state: 'available', version: '1.3.0' }]);

    const installed = setup(DOWNLOADS, ({ preferences }) => {
      preferences.set(UPDATE_CHECK_KEY, record(BUILD));
    });
    await settle();
    expect(statuses(installed.bridge)).toEqual([{ state: 'current' }]);
    await installed.bridge.installUpdate();
    expect(installed.fake.browser.open).not.toHaveBeenCalled();

    vi.setSystemTime(NOW + CHECK_INTERVAL_MS);
    const due = setup(DOWNLOADS, ({ preferences }) => {
      preferences.set(UPDATE_CHECK_KEY, record(BUILD + 1));
    });
    await settle();
    expect(due.fake.http.get).toHaveBeenCalledOnce();
  });

  it('reports a failed check', async () => {
    const { bridge, fake } = setup(DOWNLOADS, ({ fake: plugins }) => {
      plugins.http.get.mockResolvedValue({ status: 503, data: null });
    });
    await settle();
    const seen = statuses(bridge);
    fake.http.get.mockRejectedValueOnce(new Error('offline'));
    await bridge.checkForUpdates();
    expect(seen).toEqual([{ state: 'failed' }, { state: 'checking' }, { state: 'failed' }]);
  });
});
