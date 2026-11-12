// Languages search stems words in: Snowball stemmers that both PostgreSQL and the web app have.
// No Zod, so browsers can import it.

/** Stemmer names by primary language subtag. */
export const SEARCH_LANGUAGES = {
  ar: 'arabic',
  da: 'danish',
  de: 'german',
  el: 'greek',
  en: 'english',
  es: 'spanish',
  fi: 'finnish',
  fr: 'french',
  ga: 'irish',
  hu: 'hungarian',
  hy: 'armenian',
  id: 'indonesian',
  it: 'italian',
  lt: 'lithuanian',
  nb: 'norwegian',
  ne: 'nepali',
  nl: 'dutch',
  nn: 'norwegian',
  no: 'norwegian',
  pt: 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  sr: 'serbian',
  sv: 'swedish',
  ta: 'tamil',
  tr: 'turkish',
} as const;

export type SearchLanguage = (typeof SEARCH_LANGUAGES)[keyof typeof SEARCH_LANGUAGES];

/** The stemmer for a language tag (`pt-BR`, `en_US`), or null when search has none. */
export function searchLanguage(tag: string | null | undefined): SearchLanguage | null {
  const primary = /^[A-Za-z]+/.exec(tag ?? '')?.[0]?.toLowerCase();
  return primary && primary in SEARCH_LANGUAGES
    ? SEARCH_LANGUAGES[primary as keyof typeof SEARCH_LANGUAGES]
    : null;
}
