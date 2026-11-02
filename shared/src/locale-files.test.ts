import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCALE_PACKAGES, localeFiles, localeProblems, repositoryFile } from './locale-check.ts';
import { DEFAULT_LOCALE, LOCALES } from './locales.ts';

const codes = LOCALES.map((locale) => locale.code).sort();

describe.each(LOCALE_PACKAGES)('%s locale files', (name) => {
  const files = localeFiles(name);
  const source = files.get(DEFAULT_LOCALE) ?? {};

  it('are the languages in the registry', () => {
    expect([...files.keys()].sort()).toEqual(codes);
  });

  it.each(LOCALES.map((locale) => [locale.code, locale] as const))(
    '%s is sound',
    (code, locale) => {
      const forms = code === DEFAULT_LOCALE ? undefined : locale.plurals.length;
      expect(localeProblems(source, files.get(code) ?? {}, forms)).toEqual([]);
    },
  );
});

describe('Vuetify messages', () => {
  it('have a wrapper for every language but the one always loaded', () => {
    const translated = codes.filter((code) => code !== DEFAULT_LOCALE);
    const missing = translated.filter(
      (code) => !existsSync(repositoryFile(`web/src/locales/vuetify/${code}.ts`)),
    );
    expect(missing).toEqual([]);
  });
});

describe('Android per-app languages', () => {
  const config = repositoryFile('mobile/android/app/src/main/res/xml/locales_config.xml');

  it.runIf(existsSync(config))('are the languages in the registry', () => {
    const declared = [...readFileSync(config, 'utf8').matchAll(/android:name="([^"]+)"/g)];
    expect(declared.map((match) => match[1]).sort()).toEqual(codes);
  });
});
