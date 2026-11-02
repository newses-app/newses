// `pnpm locales:status`: the messages each language has yet to translate. These fall back to
// English, so this only informs a translation pass and never fails.
import { LOCALE_PACKAGES, localeFiles, messageEntries, missingKeys } from './locale-check.ts';
import { DEFAULT_LOCALE } from './locales.ts';

for (const name of LOCALE_PACKAGES) {
  const files = localeFiles(name);
  const source = files.get(DEFAULT_LOCALE) ?? {};
  const total = messageEntries(source).length;
  const translations = [...files].filter(([code]) => code !== DEFAULT_LOCALE);
  console.log(`${name}: ${String(total)} messages`);
  if (translations.length === 0) console.log('  no translations');
  for (const [code, messages] of translations) {
    const missing = missingKeys(source, messages);
    console.log(`  ${code}: ${String(missing.length)} missing`);
    for (const key of missing) console.log(`    ${key}`);
  }
}
