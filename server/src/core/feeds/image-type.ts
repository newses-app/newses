const ascii = (text: string) => [...Buffer.from(text, 'ascii')];

/** Leading bytes of the image formats browsers render, for servers that mislabel them. */
const SIGNATURES: [string, number, number[]][] = [
  ['image/png', 0, [0x89, ...ascii('PNG')]],
  ['image/gif', 0, ascii('GIF8')],
  ['image/jpeg', 0, [0xff, 0xd8]],
  ['image/x-icon', 0, [0x00, 0x00, 0x01, 0x00]],
  ['image/webp', 8, ascii('WEBP')],
  ['image/avif', 4, ascii('ftypavif')],
];

/** The image media type to serve `body` as, or null when it is not an image. */
export function imageContentType(body: Uint8Array, contentType: string | null): string | null {
  const declared = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared.startsWith('image/')) return declared;
  const match = SIGNATURES.find(([, offset, bytes]) =>
    bytes.every((byte, i) => body[offset + i] === byte),
  );
  return match?.[0] ?? null;
}
