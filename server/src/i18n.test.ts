import { LOCALES } from '@newses/shared/locales';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptedLanguages, MESSAGES, messagesFor, ownerLocale, pageLocale } from './i18n.ts';
import en from './locales/en.json' with { type: 'json' };

describe('acceptedLanguages', () => {
  it('ranks by quality, keeping the order of equals', () => {
    expect(acceptedLanguages('fr;q=0.5, es-MX, en;q=0.8, de')).toEqual(['es-MX', 'de', 'en', 'fr']);
  });

  it('leaves out wildcards, refused languages, and nonsense', () => {
    expect(acceptedLanguages('*, es;q=0, ,en;q=x, fr;Q=0.1')).toEqual(['fr']);
    expect(acceptedLanguages(undefined)).toEqual([]);
    expect(acceptedLanguages('')).toEqual([]);
  });
});

describe('pageLocale', () => {
  const available = ['en', 'es'];

  it("takes the viewer's language", () => {
    expect(pageLocale('es-MX,en;q=0.5', 'en', available)).toBe('es');
  });

  it("falls back to the owner's language, then the default", () => {
    expect(pageLocale('fr', 'es', available)).toBe('es');
    expect(pageLocale(undefined, 'es-MX', available)).toBe('es');
    expect(pageLocale('fr', 'de', available)).toBe('en');
    expect(pageLocale(undefined, null, available)).toBe('en');
  });
});

describe('messagesFor', () => {
  afterEach(() => {
    delete MESSAGES.xx;
  });

  it('holds every language in the registry', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual(LOCALES.map((locale) => locale.code).sort());
  });

  it('shows messages not yet translated in English', () => {
    MESSAGES.xx = { untitled: 'xx' };
    expect(messagesFor('xx')).toMatchObject({ untitled: 'xx', attachments: en.attachments });
    expect(messagesFor('unknown')).toEqual(en);
  });
});

describe('ownerLocale', () => {
  it('uses the default for a language not chosen or not on offer', () => {
    expect(ownerLocale(null)).toBe('en');
    expect(ownerLocale('tlh')).toBe('en');
    expect(ownerLocale('en-GB')).toBe('en');
  });
});
