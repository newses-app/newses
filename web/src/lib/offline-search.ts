import type { Entry } from '@newses/shared';

/** Scripts written without spaces between words: indexed as overlapping character pairs. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RUN = /[\p{L}\p{N}]+/gu;
/** Longer tokens are cut, so a pasted hash or URL cannot bloat the index. */
const MAX_WORD = 40;
/** Distinct words kept per article; the first ones, which include the title's and lead's. */
const MAX_WORDS = 2000;

/**
 * Lower case, with accents and other combining marks folded away: "Café" matches "cafe". Composed
 * again afterwards, so Hangul syllables stay whole.
 */
const fold = (text: string) =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase();

/** One run of letters and digits as tokens: itself, or for CJK its character pairs. */
function runTokens(run: string): string[] {
  const chars = Array.from(run);
  if (!chars.some((c) => CJK.test(c))) return [chars.slice(0, MAX_WORD).join('')];
  // Mixed runs ("iPhone用") split into their CJK and other parts.
  const tokens: string[] = [];
  let other = '';
  let cjk: string[] = [];
  const flush = () => {
    if (other) tokens.push(Array.from(other).slice(0, MAX_WORD).join(''));
    other = '';
    if (cjk.length === 1) tokens.push(cjk[0] ?? '');
    for (let i = 0; i + 1 < cjk.length; i++) tokens.push(`${cjk[i] ?? ''}${cjk[i + 1] ?? ''}`);
    cjk = [];
  };
  for (const c of chars) {
    if (CJK.test(c)) {
      if (other) {
        tokens.push(Array.from(other).slice(0, MAX_WORD).join(''));
        other = '';
      }
      cjk.push(c);
    } else {
      if (cjk.length > 0) flush();
      other += c;
    }
  }
  flush();
  return tokens;
}

/** Tokens of `text`, in order, with repeats. */
export function tokenise(text: string): string[] {
  return (fold(text).match(RUN) ?? []).flatMap(runTokens);
}

/** The distinct words of texts, for the index. */
export function searchWords(...texts: (string | null | undefined)[]): string[] {
  const words = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const token of tokenise(text)) {
      words.add(token);
      if (words.size >= MAX_WORDS) return [...words];
    }
  }
  return [...words];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** The text of sanitised entry HTML: tags dropped, entities decoded. Cheap enough for thousands. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X'))
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? match;
    });
}

/** Words of an entry's headline: title, author, and feed. */
export const headlineWords = (entry: Pick<Entry, 'title' | 'author' | 'feedTitle'>) =>
  searchWords(entry.title, entry.author, entry.feedTitle);

/** Words of an entry's stored content and full text. */
export const contentWords = (content: { content: string | null; fullContent: string | null }) =>
  searchWords(
    content.content && htmlText(content.content),
    content.fullContent && htmlText(content.fullContent),
  );

/** Bytes the index spends on `words`, for the storage limit. */
export const wordBytes = (words: readonly string[]) =>
  words.reduce((sum, word) => sum + new TextEncoder().encode(word).length + 8, 0);

/**
 * A search as terms that must all match: whole words, and the last one as a prefix, so results
 * narrow while typing. CJK pairs all match whole; a lone CJK character matches as a prefix.
 */
export function searchTerms(q: string): { words: string[]; prefix: string | null } {
  const tokens = tokenise(q);
  const last = tokens.at(-1);
  if (last === undefined) return { words: [], prefix: null };
  const lastIsPair = Array.from(last).length === 2 && CJK.test(last);
  if (lastIsPair) return { words: [...new Set(tokens)], prefix: null };
  return { words: [...new Set(tokens.slice(0, -1))], prefix: last };
}
