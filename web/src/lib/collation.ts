import { i18n } from '../plugins/i18n.ts';

const collators = new Map<string, Intl.Collator>();

/** Compares titles as the app's language sorts them, ignoring case and accents it treats alike. */
export function compareTitles(a: string, b: string): number {
  const locale = i18n.global.locale.value;
  let collator = collators.get(locale);
  if (!collator)
    collators.set(locale, (collator = new Intl.Collator(locale, { sensitivity: 'base' })));
  return collator.compare(a, b);
}
