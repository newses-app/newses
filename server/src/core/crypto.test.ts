import { describe, expect, it } from 'vitest';
import { CryptoError, deriveKey, deriveKeys, open, seal, sign, verify } from './crypto.ts';

const SECRET = 'a test secret that is at least thirty-two characters';

describe('crypto', () => {
  const key = deriveKey(SECRET, 'feed-credentials');

  it('derives a distinct 256-bit key per purpose and secret', () => {
    const keys = deriveKeys(SECRET);
    expect(keys['feed-credentials']).toEqual(key);
    expect(key).toHaveLength(32);
    expect(keys.totp.equals(key)).toBe(false);
    expect(deriveKey(`${SECRET}!`, 'feed-credentials').equals(key)).toBe(false);
  });

  it('round-trips sealed values with a fresh IV each time', () => {
    const sealed = seal(key, 'pässword', 'feed:1');
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]*\.[\w-]+$/);
    expect(sealed).not.toContain('pässword');
    expect(seal(key, 'pässword', 'feed:1')).not.toBe(sealed);
    expect(open(key, sealed, 'feed:1')).toBe('pässword');
    expect(open(key, seal(key, ''))).toBe('');
  });

  it('refuses tampered values, other keys, other contexts, and garbage', () => {
    const sealed = seal(key, 'secret', 'feed:1');
    const [v, iv, ct = '', tag] = sealed.split('.');
    const flipped = `${v ?? ''}.${iv ?? ''}.${ct.slice(0, -1)}${ct.endsWith('A') ? 'B' : 'A'}.${tag ?? ''}`;
    expect(() => open(key, flipped, 'feed:1')).toThrow(CryptoError);
    expect(() => open(deriveKey(SECRET, 'totp'), sealed, 'feed:1')).toThrow(CryptoError);
    expect(() => open(key, sealed, 'feed:2')).toThrow(CryptoError);
    expect(() => open(key, 'not sealed')).toThrow(CryptoError);
    expect(() => open(key, `v2.${sealed.slice(3)}`, 'feed:1')).toThrow(CryptoError);
  });

  it('signs and verifies', () => {
    const imageKey = deriveKey(SECRET, 'image-url');
    const mac = sign(imageKey, 'https://img.example/a.png');
    expect(verify(imageKey, 'https://img.example/a.png', mac)).toBe(true);
    expect(verify(imageKey, 'https://img.example/b.png', mac)).toBe(false);
    expect(verify(deriveKey(SECRET, 'login-challenge'), 'https://img.example/a.png', mac)).toBe(
      false,
    );
    expect(verify(imageKey, 'https://img.example/a.png', mac.slice(1))).toBe(false);
  });
});
