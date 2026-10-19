import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSettings } from './settings.ts';
import { canKeepToken, createTokenStore, type Encryption } from './token.ts';
import { centered, onScreen, restoreBounds } from './window-state.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'newses-desktop-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const encryption = (backend = 'gnome_libsecret', available = true): Encryption => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (data) => {
    const text = data.toString();
    if (!text.startsWith('enc:')) throw new Error('bad key');
    return text.slice(4);
  },
});

describe('openSettings', () => {
  it('starts empty, then keeps changes across opens, readable by the user only', async () => {
    const file = join(dir, 'nested', 'settings.json');
    const settings = await openSettings(file);
    expect(settings.get()).toEqual({});
    await settings.update({ serverUrl: 'https://rr.example.com' });
    await settings.update({ window: { x: 1, y: 2, width: 800, height: 600, maximized: false } });
    const again = await openSettings(file);
    expect(again.get()).toMatchObject({ serverUrl: 'https://rr.example.com', window: { x: 1 } });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('token store', () => {
  it('keeps each profile token encrypted in settings', async () => {
    const file = join(dir, 'settings.json');
    const tokens = createTokenStore(await openSettings(file), encryption(), 'linux');
    await tokens.set('a', 't0k');
    await tokens.set('b', 't1k');
    expect(await readFile(file, 'utf8')).not.toContain('"t0k"');
    const reopened = createTokenStore(await openSettings(file), encryption(), 'linux');
    expect(reopened.get('a')).toBe('t0k');
    await reopened.clear('a');
    expect(reopened.get('a')).toBeNull();
    const again = createTokenStore(await openSettings(file), encryption(), 'linux');
    expect([again.get('a'), again.get('b')]).toEqual([null, 't1k']);
  });

  it('keeps tokens in memory only without a Linux keyring', async () => {
    expect(canKeepToken(encryption('basic_text'), 'linux')).toBe(false);
    expect(canKeepToken(encryption('basic_text'), 'win32')).toBe(true);
    expect(canKeepToken(encryption('dpapi', false), 'win32')).toBe(false);
    const file = join(dir, 'settings.json');
    const tokens = createTokenStore(await openSettings(file), encryption('basic_text'), 'linux');
    await tokens.set('a', 't0k');
    expect(tokens.get('a')).toBe('t0k');
    const reopened = createTokenStore(await openSettings(file), encryption('basic_text'), 'linux');
    expect(reopened.get('a')).toBeNull();
  });

  it('asks for sign-in when a token cannot be decrypted', async () => {
    const settings = await openSettings(join(dir, 'settings.json'));
    await settings.update({ tokens: { a: Buffer.from('other').toString('base64') } });
    expect(createTokenStore(settings, encryption(), 'win32').get('a')).toBeNull();
  });
});

describe('restoreBounds', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };
  const saved = { x: 100, y: 100, width: 1200, height: 800, maximized: false };

  it('restores bounds that are on a screen', () => {
    expect(restoreBounds(saved, [screen])).toEqual({ x: 100, y: 100, width: 1200, height: 800 });
  });

  it('forgets bounds on a screen that is gone, or invalid ones', () => {
    expect(restoreBounds({ ...saved, x: 3000 }, [screen])).toBeNull();
    expect(restoreBounds({ ...saved, x: 1900 }, [screen])).toBeNull();
    expect(restoreBounds({ ...saved, width: 0 }, [screen])).toBeNull();
    expect(restoreBounds(undefined, [screen])).toBeNull();
  });

  it('forgets the spot WSLg parks a minimized window at', () => {
    const parked = { ...saved, x: -32730, y: -32709 };
    expect(onScreen(parked, [screen])).toBe(false);
    expect(restoreBounds(parked, [screen])).toBeNull();
  });
});

describe('centered', () => {
  it('centres a window on a screen, shrinking it to fit', () => {
    const size = { width: 1200, height: 800 };
    expect(centered(size, { x: 1920, y: 40, width: 2560, height: 1400 })).toEqual({
      x: 2600,
      y: 340,
      width: 1200,
      height: 800,
    });
    expect(centered(size, { x: 0, y: 0, width: 1024, height: 700 })).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 700,
    });
  });
});
