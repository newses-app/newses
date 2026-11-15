import { LOCALES } from '@newses/shared/locales';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptedLanguages,
  type MessageKey,
  MESSAGES,
  messagesFor,
  ownerLocale,
  pageLocale,
  translate,
} from './i18n.ts';
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
    expect(messagesFor('unknown')).toEqual(messagesFor('en'));
    expect(messagesFor('unknown').untitled).toBe(en.untitled);
  });
});

describe('translate', () => {
  // Messages under test, as the locale files have none with parameters yet.
  const key = 'test.unread' as MessageKey;
  const messages = MESSAGES as Record<string, Record<string, string>>;
  const english = '{count} unread entry in {feed} | {count} unread entries in {feed}';

  afterEach(() => {
    for (const code of Object.keys(messages)) delete messages[code]?.[key];
    delete MESSAGES.xx;
  });

  function given(translations: Record<string, string>) {
    for (const [code, message] of Object.entries({ en: english, ...translations })) {
      (messages[code] ??= {})[key] = message;
    }
  }

  it('fills placeholders and picks plural forms in each language', () => {
    given({
      de: '{count} ungelesener Artikel in {feed} | {count} ungelesene Artikel in {feed}',
      es: '{count} artículo sin leer en {feed} | {count} artículos sin leer en {feed}',
      it: '{count} articolo da leggere in {feed} | {count} articoli da leggere in {feed}',
    });
    const shown = (locale: string) =>
      [1, 12345].map((count) => translate(locale, key, { count, feed: 'Tech' }));
    expect(['en', 'de', 'es', 'it'].map(shown)).toEqual([
      ['1 unread entry in Tech', '12,345 unread entries in Tech'],
      ['1 ungelesener Artikel in Tech', '12.345 ungelesene Artikel in Tech'],
      ['1 artículo sin leer en Tech', '12.345 artículos sin leer en Tech'],
      ['1 articolo da leggere in Tech', '12.345 articoli da leggere in Tech'],
    ]);
  });

  it("falls back to English, with its forms and the language's number format", () => {
    given({});
    expect(translate('de', key, { count: 1000, feed: 'Tech' })).toBe(
      '1.000 unread entries in Tech',
    );
    expect(translate('unknown', key, { count: 1, feed: 'Tech' })).toBe('1 unread entry in Tech');
  });

  it('shows plain messages as they are', () => {
    expect(translate('es', 'readOriginal')).toBe(MESSAGES.es?.readOriginal);
    expect(translate('en', 'untitled')).toBe(en.untitled);
  });
});

describe('ownerLocale', () => {
  it('uses the default for a language not chosen or not on offer', () => {
    expect(ownerLocale(null)).toBe('en');
    expect(ownerLocale('tlh')).toBe('en');
    expect(ownerLocale('en-GB')).toBe('en');
  });
});
