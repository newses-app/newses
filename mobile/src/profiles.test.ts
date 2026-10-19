import { createProfiles } from '@newses/shared/profiles';
import { describe, expect, it } from 'vitest';
import { capacitorProfileStorage, type KeyValueStore } from './profiles.ts';

function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const kv: KeyValueStore = {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
  return { kv, values };
}

describe('Android profiles', () => {
  it('moves the server and token of an earlier version into an active profile', async () => {
    const preferences = store({ serverUrl: 'https://one.example', updateCheck: '{}' });
    const secure = store({ token: 't1' });
    const profiles = createProfiles(capacitorProfileStorage(preferences.kv, secure.kv));
    const { profiles: list, active } = await profiles.list();
    expect(list).toMatchObject([{ serverUrl: 'https://one.example', signedIn: true }]);
    expect(await profiles.getToken()).toBe('t1');
    expect([...preferences.values.keys()].sort()).toEqual(['profiles', 'updateCheck']);
    expect([...secure.values.keys()]).toEqual([`token.${String(active)}`]);
  });

  it('keeps profiles in Preferences and tokens only in secure storage', async () => {
    const preferences = store();
    const secure = store();
    const first = createProfiles(capacitorProfileStorage(preferences.kv, secure.kv));
    const one = await first.add('https://one.example');
    await first.setActive(one.id);
    await first.setToken('t1');
    expect(preferences.values.get('profiles')).not.toContain('t1');
    const again = createProfiles(capacitorProfileStorage(preferences.kv, secure.kv));
    expect(await again.list()).toMatchObject({ profiles: [{ signedIn: true }], active: one.id });
    expect(await again.remove(one.id)).toBe('t1');
    expect(secure.values.size).toBe(0);
  });
});
