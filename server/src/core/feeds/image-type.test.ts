import { describe, expect, it } from 'vitest';
import { imageContentType } from './image-type.ts';

const SVG_TYPE = 'image/svg+xml';
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'ascii')] : p)));

describe('imageContentType', () => {
  it('trusts declared image types and sniffs mislabelled ones', () => {
    expect(imageContentType(bytes('x'), 'image/png; q=1')).toBe('image/png');
    expect(imageContentType(bytes([0x89], 'PNG\r\n'), 'application/octet-stream')).toBe(
      'image/png',
    );
    expect(imageContentType(bytes('GIF89a'), null)).toBe('image/gif');
    expect(imageContentType(bytes([0xff, 0xd8, 0xff]), null)).toBe('image/jpeg');
    expect(imageContentType(bytes([0, 0, 1, 0]), null)).toBe('image/x-icon');
    expect(imageContentType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8'), null)).toBe('image/webp');
    expect(imageContentType(bytes([0, 0, 0, 0x1c], 'ftypavif'), null)).toBe('image/avif');
    expect(imageContentType(bytes('<html>'), 'text/html')).toBeNull();
  });

  it('gives SVG the charset its bytes, the server, or its XML declaration say', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(imageContentType(bytes(svg), 'image/svg+xml')).toBe('image/svg+xml; charset=utf-8');
    expect(imageContentType(bytes(svg), 'Image/SVG+XML; Charset="ISO-8859-1"')).toBe(
      'image/svg+xml; charset=iso-8859-1',
    );
    expect(
      imageContentType(bytes(`<?xml version="1.0" encoding='Windows-1252'?>${svg}`), SVG_TYPE),
    ).toBe('image/svg+xml; charset=windows-1252');
    expect(imageContentType(bytes('<?xml version="1.0"?>', svg), SVG_TYPE)).toBe(
      'image/svg+xml; charset=utf-8',
    );
    expect(imageContentType(bytes([0xff, 0xfe], '<'), 'image/svg+xml; charset=utf-8')).toBe(
      'image/svg+xml; charset=utf-16le',
    );
  });
});
