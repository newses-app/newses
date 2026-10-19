import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfiles } from '@newses/shared/profiles';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsProfileStorage } from './profiles.ts';
import { openSettings } from './settings.ts';
import { createTokenStore, type Encryption } from './token.ts';

let dir = '';
let file = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'newses-profiles-'));
  file = join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const encryption = (backend = 'gnome_libsecret'): Encryption => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (data) => data.toString().slice(4),
});

async function open(backend?: string) {
  const settings = await openSettings(file);
  const tokens = createTokenStore(settings, encryption(backend), 'linux');
  return { settings, profiles: createProfiles(settingsProfileStorage(settings, tokens)) };
}

describe('desktop profiles', () => {
  it('moves the server and token of an earlier version into an active profile', async () => {
    const before = await openSettings(file);
    await before.update({
      serverUrl: 'https://one.example',
      token: Buffer.from('enc:t1').toString('base64'),
      window: { x: 1, y: 2, width: 800, height: 600, maximized: false },
    });
    const { settings, profiles } = await open();
    const { profiles: list, active } = await profiles.list();
    expect(list).toMatchObject([{ serverUrl: 'https://one.example', signedIn: true }]);
    expect(active).toBe(list[0]?.id);
    expect(await profiles.getToken()).toBe('t1');
    expect([settings.get().serverUrl, settings.get().token]).toEqual([undefined, undefined]);
    expect(settings.get().window).toMatchObject({ x: 1 });
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(['activeProfile', 'profiles', 'tokens', 'window']);
  });

  it('keeps profiles and tokens across launches', async () => {
    const first = await open();
    const one = await first.profiles.add('https://one.example');
    const two = await first.profiles.add('https://two.example');
    await first.profiles.setActive(two.id);
    await first.profiles.setToken('t2');
    const { profiles } = await open();
    expect(await profiles.list()).toMatchObject({
      profiles: [
        { id: one.id, signedIn: false },
        { id: two.id, signedIn: true },
      ],
      active: two.id,
    });
    expect(await profiles.getToken()).toBe('t2');
  });

  it('keeps profiles but not tokens across launches without a Linux keyring', async () => {
    const first = await open('basic_text');
    const one = await first.profiles.add('https://one.example');
    await first.profiles.setActive(one.id);
    await first.profiles.setToken('t1');
    expect(await first.profiles.getToken()).toBe('t1');
    expect(await readFile(file, 'utf8')).not.toContain('tokens');
    const { profiles } = await open('basic_text');
    expect(await profiles.list()).toMatchObject({
      profiles: [{ signedIn: false }],
      active: one.id,
    });
  });

  it('removes the encrypted token of a removed profile from settings', async () => {
    const { settings, profiles } = await open();
    const one = await profiles.add('https://one.example');
    await profiles.setActive(one.id);
    await profiles.setToken('t1');
    expect(await profiles.remove(one.id)).toBe('t1');
    expect(settings.get()).toMatchObject({ profiles: [], activeProfile: null, tokens: {} });
  });
});
