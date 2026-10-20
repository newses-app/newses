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

const SVG = 'image/svg+xml';

/**
 * An SVG's character encoding, by XML's rules: a byte order mark, else the charset the server
 * declared, else the XML declaration's, else UTF-8.
 */
function svgCharset(body: Uint8Array, declared: string | undefined): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (declared) return declared;
  const head = Buffer.from(body.subarray(0, 200)).toString('latin1');
  const encoding = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([A-Za-z][\w.:-]*)["']/.exec(head)?.[1];
  return encoding?.toLowerCase() ?? 'utf-8';
}

/**
 * The image media type to serve `body` as, or null when it is not an image. SVG, which is text,
 * carries its charset.
 */
export function imageContentType(body: Uint8Array, contentType: string | null): string | null {
  const [type = '', ...params] = (contentType ?? '').split(';');
  const declared = type.trim().toLowerCase();
  if (declared === SVG) {
    const charset = params
      .map((param) => /^\s*charset\s*=\s*"?([\w.:-]+)"?\s*$/i.exec(param)?.[1])
      .find((value) => value !== undefined);
    return `${SVG}; charset=${svgCharset(body, charset?.toLowerCase())}`;
  }
  if (declared.startsWith('image/')) return declared;
  const match = SIGNATURES.find(([, offset, bytes]) =>
    bytes.every((byte, i) => body[offset + i] === byte),
  );
  return match?.[0] ?? null;
}
