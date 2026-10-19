import { describe, expect, it } from 'vitest';
import { memoryBridge } from './bridge.ts';
import { createConnection } from './connection.ts';

const alice = { id: 1, login: 'alice' };
const bob = { id: 2, login: 'bob' };

/** A profile on one.example signed in as Alice. */
async function connected() {
  const bridge = memoryBridge();
  const profile = await bridge.addProfile('https://one.example');
  await bridge.setActiveProfile(profile.id);
  await bridge.setToken('t1');
  await bridge.updateProfile(profile.id, { userId: alice.id, login: alice.login });
  const connection = createConnection(bridge);
  await connection.load();
  return { bridge, connection, profile };
}

describe('createConnection', () => {
  it('loads the profiles and the active one with its token', async () => {
    const { connection, profile } = await connected();
    expect(connection.state.active).toBe(profile.id);
    expect(connection.state.serverUrl).toBe('https://one.example');
    expect(connection.state.token).toBe('t1');
    expect(connection.activeProfile()).toMatchObject({ userId: 1, login: 'alice' });
  });

  it('starts at the connect screen on first run', async () => {
    const connection = createConnection(memoryBridge());
    await connection.load();
    expect(connection.state).toMatchObject({ profiles: [], active: null, token: null });
    expect(connection.state.serverUrl).toBeNull();
  });

  it('keeps a new profile’s first sign-in on it', async () => {
    const bridge = memoryBridge();
    const profile = await bridge.addProfile('https://one.example');
    await bridge.setActiveProfile(profile.id);
    const connection = createConnection(bridge);
    await connection.load();
    expect(await connection.signedIn('t1', alice)).toBe(false);
    expect(connection.state.token).toBe('t1');
    expect(await bridge.getToken()).toBe('t1');
    expect(connection.activeProfile()).toMatchObject({ userId: 1, login: 'alice', signedIn: true });
  });

  it('forgets the token when the session ends, keeping the profile', async () => {
    const { bridge, connection } = await connected();
    await connection.signedOut();
    expect(connection.state.token).toBeNull();
    expect(await bridge.getToken()).toBeNull();
    expect((await bridge.getProfiles()).profiles).toHaveLength(1);
  });

  it('moves another user’s sign-in to a profile of their own, leaving the first signed out', async () => {
    const { bridge, connection, profile } = await connected();
    await bridge.updateProfile(profile.id, { serverName: 'Home' });
    await connection.load();
    await connection.signedOut();
    expect(await connection.signedIn('t2', bob)).toBe(true);
    const { profiles, active } = await bridge.getProfiles();
    expect(active).not.toBe(profile.id);
    expect(profiles).toMatchObject([
      { id: profile.id, userId: 1, signedIn: false },
      {
        id: active,
        serverUrl: 'https://one.example',
        userId: 2,
        login: 'bob',
        serverName: 'Home',
        signedIn: true,
      },
    ]);
    expect(connection.state).toMatchObject({ active, token: 't2' });
  });

  it('merges a new profile into the one its user already has on that server', async () => {
    const { bridge, connection, profile } = await connected();
    const added = await bridge.addProfile('https://one.example');
    await bridge.setActiveProfile(added.id);
    await connection.load();
    expect(await connection.signedIn('t3', alice)).toBe(true);
    expect(await bridge.getProfiles()).toMatchObject({
      profiles: [{ id: profile.id, signedIn: true }],
      active: profile.id,
    });
    expect(await bridge.getToken()).toBe('t3');
  });

  it('keeps the name the server gives itself on each of its profiles', async () => {
    const { bridge, connection, profile } = await connected();
    const other = await bridge.addProfile('https://two.example');
    await connection.load();
    await connection.rememberServerName('Home');
    const { profiles } = await bridge.getProfiles();
    expect(profiles.map((p) => [p.id, p.serverName])).toEqual([
      [profile.id, 'Home'],
      [other.id, null],
    ]);
    expect(connection.activeProfile()?.serverName).toBe('Home');
  });

  it('notes the user the server reports only when it changed', async () => {
    const { bridge, connection, profile } = await connected();
    await connection.remember({ id: 1, login: 'alice' });
    await connection.remember({ id: 1, login: 'alice.l' });
    expect((await bridge.getProfiles()).profiles[0]).toMatchObject({
      id: profile.id,
      login: 'alice.l',
    });
    expect(connection.activeProfile()?.login).toBe('alice.l');
  });
});
