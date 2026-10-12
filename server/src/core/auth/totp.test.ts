import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, matchTotp, otpauthUri, timeStep } from './totp.ts';

// RFC 6238 appendix B, SHA-1 key.
const RFC_SECRET = Buffer.from('12345678901234567890');

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_SECRET, timeStep(new Date(seconds * 1000)), 8)).toBe(code);
    }
  });

  it('round-trips base32', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv-gy3tqojqgezdgnbvgy3tqojq')).toEqual(RFC_SECRET);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('accepts one step of drift and refuses replays', () => {
    const at = new Date(1_234_567_890_000);
    const step = timeStep(at);
    const code = (s: number) => hotp(RFC_SECRET, s);
    expect(matchTotp(RFC_SECRET, code(step), at, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, code(step - 1), at, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, code(step + 1), at, null)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, code(step - 2), at, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, code(step), at, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, code(step + 1), at, step)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, 'abcdef', at, null)).toBeNull();
  });

  it('builds otpauth URIs', () => {
    const text = otpauthUri(RFC_SECRET, 'alice', 'Newses');
    expect(text.startsWith('otpauth://totp/Newses:alice?')).toBe(true);
    const uri = new URL(text);
    expect(uri.searchParams.get('secret')).toBe(base32Encode(RFC_SECRET));
    expect(uri.searchParams.get('issuer')).toBe('Newses');
  });
});
