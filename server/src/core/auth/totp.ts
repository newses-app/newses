import { createHmac, randomBytes } from 'node:crypto';

// RFC 6238 TOTP with the parameters every authenticator app supports: HMAC-SHA1, 6 digits, 30 s.
const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error(`Invalid base32 character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function timeStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

/** RFC 4226 HOTP value for one counter; `digits` exists for the RFC test vectors. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The time step `code` belongs to, allowing one step of clock drift either way, or null.
 * Steps at or before `after` are refused so an accepted code cannot be replayed.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  at: Date,
  after: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = timeStep(at);
  for (const step of [now - 1, now, now + 1]) {
    if (after !== null && step <= after) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

/** Key URI understood by authenticator apps (Google's `otpauth://` format). */
export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
