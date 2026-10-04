/**
 * Decodes a response body. Charset precedence: byte-order mark, HTTP Content-Type, XML
 * declaration or HTML meta tag, then UTF-8.
 */
export function decodeBody(body: Uint8Array, contentType: string | null): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf)
    return decode(body.subarray(3), 'utf-8');
  if (body[0] === 0xfe && body[1] === 0xff) return decode(body.subarray(2), 'utf-16be');
  if (body[0] === 0xff && body[1] === 0xfe) return decode(body.subarray(2), 'utf-16le');

  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader && isSupported(fromHeader)) return decode(body, fromHeader);

  const head = new TextDecoder('latin1').decode(body.subarray(0, 1024));
  const declared =
    /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ??
    /<meta[^>]*charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  if (declared && isSupported(declared)) return decode(body, declared);

  return decode(body, 'utf-8');
}

function isSupported(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

function decode(bytes: Uint8Array, label: string): string {
  return new TextDecoder(label).decode(bytes);
}
