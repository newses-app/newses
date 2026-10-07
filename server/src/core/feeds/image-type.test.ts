import { describe, expect, it } from 'vitest';
import { imageContentType } from './image-type.ts';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'ascii')] : p)));

describe('imageContentType', () => {
  it('trusts declared image types and sniffs mislabelled ones', () => {
    expect(imageContentType(bytes('x'), 'image/svg+xml; charset=utf-8')).toBe('image/svg+xml');
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
});
