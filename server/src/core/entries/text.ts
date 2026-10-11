const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntity(entity: string, body: string): string {
  if (body.startsWith('#')) {
    const code =
      body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  }
  return NAMED[body] ?? entity;
}

/** Plain text of sanitised HTML, whitespace collapsed; null when there is none. */
export function plainText(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?[a-zA-Z0-9]+);/g, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** Plain text of sanitised HTML, whitespace collapsed, at most `max` characters. */
export function excerpt(html: string | null, max = 250): string | null {
  const text = plainText(html);
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
