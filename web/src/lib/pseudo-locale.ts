import type { Locale } from '@newses/shared/locales';

/**
 * Generated languages for development. `en-XA` is accented and longer, so text that isn't from a
 * locale file stands out and tight layouts break; `ar-XB` runs right to left.
 */
export const PSEUDO_LOCALES: readonly Locale[] = [
  { code: 'en-XA', name: 'Pseudo (en-XA)', direction: 'ltr', plurals: ['one', 'other'] },
  {
    code: 'ar-XB',
    name: 'Pseudo right-to-left (ar-XB)',
    direction: 'rtl',
    plurals: ['one', 'other'],
  },
];

const ACCENTS: Record<string, string> = {
  a: 'á',
  c: 'ç',
  e: 'é',
  i: 'í',
  n: 'ñ',
  o: 'ó',
  s: 'š',
  u: 'ú',
  y: 'ý',
  A: 'Á',
  C: 'Ç',
  E: 'É',
  I: 'Í',
  N: 'Ñ',
  O: 'Ó',
  S: 'Š',
  U: 'Ú',
  Y: 'Ý',
};

function accented(text: string): string {
  const letters = text.replace(/[a-z]/gi, (letter) => ACCENTS[letter] ?? letter);
  return `⟦${letters}${'~'.repeat(Math.ceil(text.length * 0.4))}⟧`;
}

/** Each word forced right to left, as Android's `ar-XB` does. */
const reversed = (text: string) =>
  text.replace(/\S+/g, (word) => `\u200F\u202E${word}\u202C\u200F`);

/** Placeholders, literals such as `{'@'}`, and the `|` between plural forms stay as they are. */
const MESSAGE_SYNTAX = /(\{[^}]*\}|\s*\|\s*)/;

function pseudoMessage(message: string, change: (text: string) => string): string {
  return message
    .split(MESSAGE_SYNTAX)
    .map((part, index) => (index % 2 === 1 || !part.trim() ? part : change(part)))
    .join('');
}

/** A pseudo-locale's messages, generated from the fallback language's. */
export function pseudoMessages<T extends object>(code: string, messages: T): T {
  const change = code === 'ar-XB' ? reversed : accented;
  const convert = (node: unknown): unknown => {
    if (typeof node === 'string') return pseudoMessage(node, change);
    if (typeof node === 'object' && node !== null)
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, convert(value)]));
    return node;
  };
  return convert(messages) as T;
}
