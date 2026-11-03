import { negotiateLocale } from '@newses/shared/locales';
import en from './locales/en.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import it from './locales/it.json' with { type: 'json' };

type Messages = typeof en;

/** One static import per language, as esbuild bundles them for Lambda. */
export const MESSAGES: Record<string, Partial<Messages>> = { en, es, it };

/** The text of a language; a message not yet translated is in English. */
export const messagesFor = (locale: string): Messages => ({ ...en, ...MESSAGES[locale] });

/** The language of a user's preference, for what they own: null follows no device here. */
export const ownerLocale = (language: string | null) => negotiateLocale(language ? [language] : []);

/** The languages of an `Accept-Language` header, most wanted first. */
export function acceptedLanguages(header: string | undefined): string[] {
  const ranges = (header ?? '').split(',').map((range) => {
    const [tag = '', ...params] = range.split(';').map((part) => part.trim());
    const weight = params.find((param) => /^q=/i.test(param))?.slice(2);
    return { tag, quality: weight === undefined ? 1 : Number(weight) };
  });
  return ranges
    .filter(({ tag, quality }) => tag && tag !== '*' && quality > 0)
    .sort((a, b) => b.quality - a.quality)
    .map(({ tag }) => tag);
}

/** The language of a public page: the viewer's, else its owner's, else the default. */
export const pageLocale = (
  acceptLanguage: string | undefined,
  ownerLanguage: string | null = null,
  available?: readonly string[],
) =>
  negotiateLocale(
    [...acceptedLanguages(acceptLanguage), ...(ownerLanguage ? [ownerLanguage] : [])],
    available,
  );
