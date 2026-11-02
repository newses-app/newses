import type { Locale } from '@newses/shared/locales';

/**
 * vue-i18n's plural rule for a language: the position of a count's form among those its messages
 * have. `pluralCategories` is unordered and can name forms the messages leave out (Spanish's
 * `many`), so the positions come from the registry, and any other form uses `other`.
 */
export function pluralRule({ code, plurals }: Pick<Locale, 'code' | 'plurals'>) {
  const rules = new Intl.PluralRules(code);
  const other = plurals.indexOf('other');
  return (choice: number, choicesLength: number): number => {
    const position = plurals.indexOf(rules.select(Math.abs(choice)));
    return Math.min(position < 0 ? other : position, choicesLength - 1);
  };
}
