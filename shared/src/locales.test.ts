import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, matchLocale, negotiateLocale } from './locales.ts';

const available = ['en', 'es', 'zh-Hant'];

describe('matchLocale', () => {
  it('takes the first language on offer', () => {
    expect(matchLocale(['fr', 'es', 'en'], available)).toBe('es');
  });

  it('takes a regional tag as its base language', () => {
    expect(matchLocale(['es-MX'], available)).toBe('es');
    expect(matchLocale(['en-GB', 'es'], available)).toBe('en');
  });

  it('prefers the exact tag, ignoring case', () => {
    expect(matchLocale(['ZH-hant'], available)).toBe('zh-Hant');
  });

  it('does not take a base language as a regional one', () => {
    expect(matchLocale(['zh'], available)).toBeUndefined();
  });

  it('finds nothing without a match', () => {
    expect(matchLocale(['fr'], available)).toBeUndefined();
    expect(matchLocale([], available)).toBeUndefined();
  });
});

describe('negotiateLocale', () => {
  it('falls back to the default', () => {
    expect(negotiateLocale(['fr'], available)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale([], available)).toBe(DEFAULT_LOCALE);
  });

  it('offers the shipped languages unless told otherwise', () => {
    expect(negotiateLocale(['en-US'])).toBe('en');
    expect(negotiateLocale(['es-MX'])).toBe('es');
    expect(negotiateLocale(['es-419'])).toBe('es');
    expect(negotiateLocale(['fr-FR'])).toBe('en');
  });
});

describe('LOCALES', () => {
  it('lists the default language first, each language once', () => {
    expect(LOCALES[0]?.code).toBe(DEFAULT_LOCALE);
    const codes = LOCALES.map((locale) => locale.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('ends every language with the form others fall back to', () => {
    for (const locale of LOCALES) expect(locale.plurals.at(-1)).toBe('other');
  });
});
