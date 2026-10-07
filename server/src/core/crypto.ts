import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Each use of the app secret gets its own key, so one key's output never verifies under another. */
export type KeyPurpose = 'totp' | 'feed-credentials' | 'image-url' | 'login-challenge';

export type Keys = Record<KeyPurpose, Buffer>;

const PURPOSES: KeyPurpose[] = ['totp', 'feed-credentials', 'image-url', 'login-challenge'];
const VERSION = 'v1';
const IV_BYTES = 12;

export class CryptoError extends Error {
  override name = 'CryptoError';
}

export function deriveKey(secret: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', `rss-reader/${purpose}`, 32));
}

export function deriveKeys(secret: string): Keys {
  return Object.fromEntries(PURPOSES.map((p) => [p, deriveKey(secret, p)])) as Keys;
}

/**
 * AES-256-GCM as `v1.<iv>.<ciphertext>.<tag>` (base64url). `context` is authenticated but not
 * stored: pass the owning row's identity so a value copied to another row fails to open.
 */
export function seal(key: Buffer, plaintext: string, context = ''): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** Throws CryptoError when the value is malformed, tampered with, or sealed under another key. */
export function open(key: Buffer, sealed: string, context = ''): string {
  const [version, iv, ciphertext, tag, ...rest] = sealed.split('.');
  if (version !== VERSION || !iv || ciphertext === undefined || !tag || rest.length > 0) {
    throw new CryptoError('Malformed sealed value');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    throw new CryptoError('Sealed value cannot be opened', { cause: err });
  }
}

/** HMAC-SHA256 of `data`, base64url. */
export function sign(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

export function verify(key: Buffer, data: string, mac: string): boolean {
  const expected = Buffer.from(sign(key, data));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
