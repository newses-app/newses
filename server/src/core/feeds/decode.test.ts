import { describe, expect, it } from 'vitest';
import { decodeBody } from './decode.ts';

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('decodeBody', () => {
  it('strips a UTF-8 byte-order mark', () => {
    expect(
      decodeBody(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), 'text/xml; charset=iso-8859-1'),
    ).toBe('A');
  });

  it('prefers the HTTP charset over the XML declaration', () => {
    const body = latin1('<?xml version="1.0" encoding="utf-8"?><t>caf\xe9</t>');
    expect(decodeBody(body, 'application/xml; charset=ISO-8859-1')).toContain('café');
  });

  it('uses the XML declaration, then HTML meta charset', () => {
    expect(
      decodeBody(latin1('<?xml version="1.0" encoding="ISO-8859-1"?><t>\xe9</t>'), null),
    ).toContain('é');
    expect(
      decodeBody(latin1('<html><meta charset="windows-1252"><p>\x93hi\x94</p>'), 'text/html'),
    ).toContain('“hi”');
  });

  it('defaults to UTF-8 and ignores unknown labels', () => {
    const body = new TextEncoder().encode('<t>café</t>');
    expect(decodeBody(body, 'text/xml; charset=bogus')).toBe('<t>café</t>');
  });
});
