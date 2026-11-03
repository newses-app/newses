// The languages the apps ship (no Zod, so browsers and the desktop's main process can import it).

export type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface Locale {
  /** Language tag, and the name of its `src/locales/<code>.json` in each package. */
  code: string;
  /** The language's own name, as the picker shows it. */
  name: string;
  direction: 'ltr' | 'rtl';
  /** The CLDR categories its messages have, in the order they are written; others use `other`. */
  plurals: readonly PluralForm[];
}

export const DEFAULT_LOCALE = 'en';

export const LOCALES: readonly Locale[] = [
  { code: DEFAULT_LOCALE, name: 'English', direction: 'ltr', plurals: ['one', 'other'] },
  { code: 'de', name: 'Deutsch', direction: 'ltr', plurals: ['one', 'other'] },
  { code: 'es', name: 'Español', direction: 'ltr', plurals: ['one', 'other'] },
  { code: 'it', name: 'Italiano', direction: 'ltr', plurals: ['one', 'other'] },
];

const LOCALE_CODES = LOCALES.map((locale) => locale.code);

/** The first requested language on offer, as itself or as its base language (`es-MX` as `es`). */
export function matchLocale(
  requested: readonly string[],
  available: readonly string[] = LOCALE_CODES,
): string | undefined {
  const offered = (tag: string) =>
    available.find((code) => code.toLowerCase() === tag.toLowerCase());
  for (const tag of requested) {
    const match = offered(tag) ?? offered(tag.split('-')[0] ?? tag);
    if (match) return match;
  }
  return undefined;
}

/** The language to show for what the reader or their device asks for, else the default. */
export const negotiateLocale = (
  requested: readonly string[],
  available: readonly string[] = LOCALE_CODES,
): string => matchLocale(requested, available) ?? DEFAULT_LOCALE;
