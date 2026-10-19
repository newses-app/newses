import { describe, expect, it } from 'vitest';
import {
  createProfiles,
  httpsOrigin,
  memoryProfileStorage,
  profileLabel,
  profileChanges,
  profileId,
  type ProfileStorage,
} from './profiles.ts';

const ids = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
};
const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';

describe('createProfiles', () => {
  it('starts with no profiles', async () => {
    const profiles = createProfiles(memoryProfileStorage(), ids());
    expect(await profiles.list()).toEqual({ profiles: [], active: null });
    expect(await profiles.getToken()).toBeNull();
    await expect(profiles.setToken('t0k')).rejects.toThrow('No active profile');
  });

  it('moves the server and token from before profiles into an active profile', async () => {
    const storage = memoryProfileStorage({ serverUrl: 'https://one.example', token: 't1' });
    const profiles = createProfiles(storage, ids());
    expect(await profiles.list()).toEqual({
      profiles: [
        {
          id: ID1,
          serverUrl: 'https://one.example',
          userId: null,
          login: null,
          serverName: null,
          label: null,
          signedIn: true,
        },
      ],
      active: ID1,
    });
    expect(await profiles.getToken()).toBe('t1');
    expect(await storage.loadLegacy()).toBeNull();
    // Later starts read the profiles.
    expect((await createProfiles(storage, ids()).list()).active).toBe(ID1);
  });

  it('migrates a server without a token as signed out, and drops an invalid one', async () => {
    const signedOut = createProfiles(
      memoryProfileStorage({ serverUrl: 'https://one.example', token: null }),
      ids(),
    );
    expect((await signedOut.list()).profiles[0]?.signedIn).toBe(false);
    const storage = memoryProfileStorage({ serverUrl: 'http://one.example', token: 't1' });
    expect(await createProfiles(storage, ids()).list()).toEqual({ profiles: [], active: null });
    expect(await storage.loadLegacy()).toBeNull();
  });

  it('migrates again when a start stopped before saving the profiles', async () => {
    const storage = memoryProfileStorage({ serverUrl: 'https://one.example', token: 't1' });
    const failing: ProfileStorage = { ...storage, save: () => Promise.reject(new Error('disk')) };
    await expect(createProfiles(failing, ids()).list()).rejects.toThrow('disk');
    expect(await storage.loadLegacy()).toEqual({ serverUrl: 'https://one.example', token: 't1' });
    expect(await createProfiles(storage, ids()).getToken()).toBe('t1');
  });

  it('adds signed-out profiles without changing the active one', async () => {
    const profiles = createProfiles(memoryProfileStorage(), ids());
    const one = await profiles.add('https://one.example');
    expect(one).toMatchObject({ id: ID1, serverUrl: 'https://one.example', signedIn: false });
    await profiles.setActive(one.id);
    await profiles.add('https://one.example');
    expect(await profiles.list()).toMatchObject({
      profiles: [{ id: ID1 }, { id: ID2 }],
      active: ID1,
    });
    await expect(profiles.add('https://one.example/path')).rejects.toThrow('Not an HTTPS origin');
    await expect(profiles.setActive('nope')).rejects.toThrow('No such profile');
  });

  it('keeps tokens per profile and uses the active one', async () => {
    const profiles = createProfiles(memoryProfileStorage(), ids());
    const one = await profiles.add('https://one.example');
    const two = await profiles.add('https://two.example');
    await profiles.setActive(one.id);
    await profiles.setToken('t1');
    await profiles.setActive(two.id);
    expect(await profiles.getToken()).toBeNull();
    await profiles.setToken('t2');
    await profiles.setActive(one.id);
    expect(await profiles.getToken()).toBe('t1');
    expect((await profiles.list()).profiles.map((p) => p.signedIn)).toEqual([true, true]);
    await profiles.clearToken();
    expect((await profiles.list()).profiles.map((p) => p.signedIn)).toEqual([false, true]);
  });

  it('updates what the app learns at sign-in, and refuses anything else', async () => {
    const profiles = createProfiles(memoryProfileStorage(), ids());
    const { id } = await profiles.add('https://one.example');
    await profiles.update(id, { userId: 7, login: 'ada', label: 'Home' });
    expect((await profiles.list()).profiles[0]).toMatchObject({
      userId: 7,
      login: 'ada',
      label: 'Home',
    });
    await profiles.update(id, { label: null });
    expect((await profiles.list()).profiles[0]?.label).toBeNull();
    const bad = { serverUrl: 'https://evil.example' } as never;
    await expect(profiles.update(id, bad)).rejects.toThrow('Invalid profile changes');
    await expect(profiles.update(ID2, { label: 'x' })).rejects.toThrow('No such profile');
  });

  it('removes a profile and its token, returning the token once', async () => {
    const storage = memoryProfileStorage();
    const profiles = createProfiles(storage, ids());
    const one = await profiles.add('https://one.example');
    const two = await profiles.add('https://two.example');
    await profiles.setActive(one.id);
    await profiles.setToken('t1');
    expect(await profiles.remove(one.id)).toBe('t1');
    expect(await storage.getToken(one.id)).toBeNull();
    expect(await profiles.list()).toMatchObject({ profiles: [{ id: two.id }], active: null });
    expect(await profiles.remove(two.id)).toBeNull();
  });

  it('reads profiles saved before a field was added with its default', async () => {
    const storage = memoryProfileStorage();
    const old = { id: ID1, serverUrl: 'https://one.example', userId: 1, login: 'ada', label: null };
    await storage.save({ profiles: [old as never], active: ID1 });
    expect((await createProfiles(storage, ids()).list()).profiles[0]?.serverName).toBeNull();
  });

  it('runs calls one at a time, so concurrent adds are all kept', async () => {
    const profiles = createProfiles(memoryProfileStorage(), ids());
    await Promise.all([1, 2, 3].map((n) => profiles.add(`https://${String(n)}.example`)));
    expect((await profiles.list()).profiles).toHaveLength(3);
  });
});

describe('profileLabel', () => {
  it('names a profile by its label, else its user and server', () => {
    const profile = {
      serverUrl: 'https://one.example:8443',
      login: null,
      serverName: null,
      label: null,
    };
    expect(profileLabel(profile)).toBe('one.example:8443');
    expect(profileLabel({ ...profile, login: 'ada' })).toBe('ada @ one.example:8443');
    expect(profileLabel({ ...profile, login: 'ada', serverName: 'Home' })).toBe('ada @ Home');
    expect(profileLabel({ ...profile, serverName: 'Home' })).toBe('Home');
    expect(profileLabel({ ...profile, login: 'ada', label: 'Mine' })).toBe('Mine');
  });
});

describe('validation', () => {
  it('accepts HTTPS origins only', () => {
    expect(httpsOrigin('https://rr.example.com')).toBe('https://rr.example.com');
    expect(httpsOrigin('https://rr.example.com/path')).toBeNull();
    expect(httpsOrigin('http://rr.example.com')).toBeNull();
    expect(httpsOrigin(42)).toBeNull();
  });

  it('accepts profile ids as the shells make them', () => {
    expect(profileId(crypto.randomUUID())).not.toBeNull();
    expect(profileId(ID1)).toBe(ID1);
    expect(profileId('../settings')).toBeNull();
    expect(profileId(1)).toBeNull();
  });

  it('checks each changed field', () => {
    expect(profileChanges({ userId: 3, label: null })).toEqual({ userId: 3, label: null });
    expect(profileChanges({ serverName: 'Home' })).toEqual({ serverName: 'Home' });
    expect(profileChanges({})).toEqual({});
    expect(profileChanges({ userId: 0 })).toBeNull();
    expect(profileChanges({ userId: 1.5 })).toBeNull();
    expect(profileChanges({ login: 'x'.repeat(257) })).toBeNull();
    expect(profileChanges({ signedIn: true })).toBeNull();
    expect(profileChanges(null)).toBeNull();
  });
});
