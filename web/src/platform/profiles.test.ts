import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const revokeSession = vi.fn(() => Promise.resolve());

// The apps' build, on a bridge that keeps profiles in memory.
vi.mock('./index.ts', async (importOriginal) => {
  const { memoryBridge } = await import('./bridge.ts');
  const { createConnection } = await import('./connection.ts');
  const bridge = memoryBridge();
  return {
    ...(await importOriginal<object>()),
    NATIVE: true,
    bridge,
    connection: createConnection(bridge),
  };
});
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeSession,
}));

/** Fresh modules, as after a reload; the mocked platform module, and its bridge, is kept. */
async function load() {
  const platform = await import('./index.ts');
  const profiles = await import('./profiles.ts');
  const store = await import('../offline/store.ts');
  const account = await import('../offline/account.ts');
  return { ...platform, ...profiles, ...store, ...account };
}

type App = Awaited<ReturnType<typeof load>>;

/** Adds a profile signed in as `userId`, with a store holding `pending` unsent changes. */
async function signedIn(app: App, serverUrl: string, userId: number, pending = 0) {
  const { bridge, connection } = app;
  const profile = await bridge.addProfile(serverUrl);
  const before = connection.state.active;
  await bridge.setActiveProfile(profile.id);
  await bridge.setToken(`t${String(userId)}`);
  await connection.load();
  await app.storeSignedIn({ userId, serverUrl });
  const db = app.currentStore();
  if (!db) throw new Error('No store');
  await db.meta.put({ key: 'syncToken', value: 's' });
  for (let i = 0; i < pending; i++) await db.outbox.add({ kind: 'k', payload: {}, queuedAt: 0 });
  const name = app.lastAccount()?.name ?? '';
  if (before) await bridge.setActiveProfile(before);
  await connection.load();
  return { ...profile, name };
}

let reload: ReturnType<typeof vi.fn<() => void>>;
beforeEach(async () => {
  const { bridge, connection } = await import('./index.ts');
  for (const { id } of (await bridge.getProfiles()).profiles) await bridge.removeProfile(id);
  await connection.load();
  vi.resetModules();
  localStorage.clear();
  revokeSession.mockClear();
  reload = vi.fn<() => void>();
  vi.spyOn(window.location, 'reload').mockImplementation(reload);
});

describe('switchProfile', () => {
  it('reloads the app on the chosen profile, keeping the store it leaves', async () => {
    const app = await load();
    const one = await signedIn(app, 'https://one.example', 1);
    await app.bridge.setActiveProfile(one.id);
    await app.connection.load();
    const two = await signedIn(app, 'https://two.example', 2);
    await app.switchProfile(two.id, '/starred');
    expect(reload).toHaveBeenCalledOnce();
    expect(location.pathname).toBe('/starred');
    expect((await app.bridge.getProfiles()).active).toBe(two.id);
    expect(await Dexie.exists(one.name)).toBe(true);
    // Until the reload, nothing opens the store of the profile left.
    expect(app.currentStore()).toBeNull();
    expect(app.accountOf(one.id)?.name).toBe(one.name);
    expect(app.accountOf(two.id)?.name).toBe(two.name);
  });
});

describe('connectTo', () => {
  it('moves to a signed-in profile of the server, else to a new one', async () => {
    const app = await load();
    const signedOut = await app.bridge.addProfile('https://one.example');
    const one = await signedIn(app, 'https://one.example', 1);
    await app.connection.load();
    await app.connectTo('https://one.example');
    expect((await app.bridge.getProfiles()).active).toBe(one.id);
    expect(signedOut.id).not.toBe(one.id);
    await app.connectTo('https://two.example');
    const { profiles, active } = await app.bridge.getProfiles();
    expect(profiles).toHaveLength(3);
    expect(profiles.find((p) => p.id === active)).toMatchObject({
      serverUrl: 'https://two.example',
      signedIn: false,
    });
  });
});

describe('removeProfile', () => {
  it('asks before losing unsent changes, then deletes what the device kept and the session', async () => {
    const app = await load();
    const active = await signedIn(app, 'https://one.example', 1);
    await app.bridge.setActiveProfile(active.id);
    await app.connection.load();
    const other = await signedIn(app, 'https://two.example', 2, 3);
    localStorage.setItem(`newses.offline.settings.${other.id}`, '{}');
    const confirm = vi.fn(() => Promise.resolve(false));

    expect(await app.removeProfile(other, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(3);
    expect(await Dexie.exists(other.name)).toBe(true);

    confirm.mockResolvedValue(true);
    expect(await app.removeProfile(other, confirm)).toBe(true);
    expect(revokeSession).toHaveBeenCalledWith('https://two.example', 't2');
    expect(await Dexie.exists(other.name)).toBe(false);
    expect(localStorage.getItem(`newses.offline.settings.${other.id}`)).toBeNull();
    expect(app.accountOf(other.id)).toBeNull();
    expect(app.connection.state.profiles.map((p) => p.id)).toEqual([active.id]);
    expect(reload).not.toHaveBeenCalled();
    expect(await Dexie.exists(active.name)).toBe(true);
  });

  it('moves the app to another profile when the active one goes', async () => {
    const app = await load();
    const other = await signedIn(app, 'https://two.example', 2);
    const active = await signedIn(app, 'https://one.example', 1);
    await app.bridge.setActiveProfile(active.id);
    await app.connection.load();
    expect(await app.removeProfile(active, () => Promise.resolve(true))).toBe(true);
    expect(await app.bridge.getProfiles()).toMatchObject({
      profiles: [{ id: other.id }],
      active: other.id,
    });
    expect(await Dexie.exists(active.name)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
