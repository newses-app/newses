import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, vapidAuthorization, vapidKeys } from './web-push.ts';

const b64 = (text: string) => Buffer.from(text, 'base64url');

describe('encryptPayload', () => {
  it('matches the example in RFC 8291, appendix A', () => {
    const body = encryptPayload(
      b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      {
        salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
        senderKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });
});

describe('vapidKeys', () => {
  it('gives the same key pair for the same seed', () => {
    const seed = Buffer.alloc(32, 7);
    expect(vapidKeys(seed).publicKey.equals(vapidKeys(seed).publicKey)).toBe(true);
    expect(vapidKeys(Buffer.alloc(32, 8)).publicKey.equals(vapidKeys(seed).publicKey)).toBe(false);
    expect(vapidKeys(seed).publicKey).toHaveLength(65);
  });

  it('turns any 32 bytes into a valid private key', () => {
    expect(vapidKeys(Buffer.alloc(32, 0xff)).publicKey).toHaveLength(65);
    expect(vapidKeys(Buffer.alloc(32)).publicKey).toHaveLength(65);
  });
});

describe('vapidAuthorization', () => {
  it('signs a JWT for the push service with the public key beside it', () => {
    const keys = vapidKeys(Buffer.alloc(32, 7));
    const header = vapidAuthorization(
      'https://push.example/send/abc?x=1',
      keys,
      'https://reader.example',
      Date.UTC(2026, 0, 1),
    );

    const [, token = '', key = ''] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(b64(key).equals(keys.publicKey)).toBe(true);
    const [head = '', claims = '', signature = ''] = token.split('.');
    expect(JSON.parse(b64(head).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b64(claims).toString())).toEqual({
      aud: 'https://push.example',
      exp: Date.UTC(2026, 0, 1) / 1000 + 12 * 60 * 60,
      sub: 'https://reader.example',
    });
    const publicKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: keys.publicKey.subarray(1, 33).toString('base64url'),
        y: keys.publicKey.subarray(33).toString('base64url'),
      },
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        b64(signature),
      ),
    ).toBe(true);
  });
});
