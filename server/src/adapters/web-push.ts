import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';

// Web Push message encryption (RFC 8291) and VAPID (RFC 8292), with node:crypto only.

/** Order of the P-256 group: private keys lie in [1, n - 1]. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** One record holds the whole message (RFC 8188's default record size). */
const RECORD_SIZE = 4096;

export interface VapidKeys {
  /** Uncompressed P-256 public key, 65 bytes; apps pass it as `applicationServerKey`. */
  publicKey: Buffer;
  privateKey: KeyObject;
}

/** The server's VAPID key pair, from 32 bytes derived from the app secret. */
export function vapidKeys(seed: Buffer): VapidKeys {
  const scalar = (BigInt(`0x${seed.toString('hex')}`) % (P256_ORDER - 1n)) + 1n;
  const d = Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const publicKey = ecdh.getPublicKey();
  const privateKey = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: d.toString('base64url'),
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33).toString('base64url'),
    },
  });
  return { publicKey, privateKey };
}

/**
 * The `Authorization` header for one push service (RFC 8292): a JWT for the endpoint's origin,
 * valid for 12 hours, naming `subject` (an https or mailto URL) as the sender's contact.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = Date.now(),
): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  };
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey.toString('base64url')}`;
}

/** Fixed inputs for tests; random otherwise. */
export interface EncryptionInputs {
  salt?: Buffer;
  /** The sender's one-off P-256 private key. */
  senderKey?: Buffer;
}

/**
 * `payload` encrypted for one device (RFC 8291, `aes128gcm`): a body only the holder of `p256dh`'s
 * private key and `auth` can read, whatever push service carries it.
 */
export function encryptPayload(
  payload: Uint8Array,
  device: { p256dh: string; auth: string },
  inputs: EncryptionInputs = {},
): Buffer {
  const deviceKey = Buffer.from(device.p256dh, 'base64url');
  const authSecret = Buffer.from(device.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (inputs.senderKey) ecdh.setPrivateKey(inputs.senderKey);
  else ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(deviceKey);
  const salt = inputs.salt ?? randomBytes(16);

  const hkdf = (ikm: Buffer, hkdfSalt: Buffer, info: Buffer, length: number) =>
    Buffer.from(hkdfSync('sha256', ikm, hkdfSalt, info, length));
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), deviceKey, senderPublic]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so the last-record delimiter (2) follows the payload with no padding.
  const ciphertext = Buffer.concat([
    cipher.update(payload),
    cipher.update(Buffer.from([2])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, ciphertext]);
}
