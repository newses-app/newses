import { describe, expect, it } from 'vitest';
import { formatMessage, pluralRule, shownParam } from './messages.ts';

const COUNTS = [0, 1, 2, 3, 11, 100, 1_000_000];

describe('pluralRule', () => {
  it('uses `other` for forms the messages leave out', () => {
    const spanish = pluralRule({ code: 'es', plurals: ['one', 'other'] });
    expect(COUNTS.map((count) => spanish(count, 2))).toEqual([1, 0, 1, 1, 1, 1, 1]);
  });

  it('ignores the sign', () => {
    expect(pluralRule({ code: 'es', plurals: ['one', 'other'] })(-1, 2)).toBe(0);
  });

  it('keeps the order of the messages, whatever order CLDR lists them in', () => {
    const arabic = pluralRule({
      code: 'ar',
      plurals: ['zero', 'one', 'two', 'few', 'many', 'other'],
    });
    expect(COUNTS.map((count) => arabic(count, 6))).toEqual([0, 1, 2, 3, 4, 5, 5]);
  });

  it('never points past a message with too few forms', () => {
    const hebrew = pluralRule({ code: 'he', plurals: ['one', 'two', 'other'] });
    expect(hebrew(2, 3)).toBe(1);
    expect(hebrew(5, 2)).toBe(1);
    expect(hebrew(2, 1)).toBe(0);
  });
});

describe('shownParam', () => {
  it('formats numbers for the language', () => {
    expect(shownParam(1234567, 'en', false)).toBe('1,234,567');
    expect(shownParam(1234567, 'es', false)).toBe('1.234.567');
    expect(shownParam(0, 'en', false)).toBe('0');
  });

  it('leaves left-to-right text alone in a left-to-right UI', () => {
    expect(shownParam('Fish & Chips', 'en', false)).toBe('Fish & Chips');
  });

  it('isolates right-to-left text in any UI', () => {
    expect(shownParam('חדשות', 'en', false)).toBe('\u2068חדשות\u2069');
    expect(shownParam('أخبار 24', 'en', false)).toBe('\u2068أخبار 24\u2069');
  });

  it('isolates all text in a right-to-left UI', () => {
    expect(shownParam('Fish!', 'ar', true)).toBe('\u2068Fish!\u2069');
  });

  it('leaves empty text and other values alone', () => {
    expect(shownParam('', 'ar', true)).toBe('');
    expect(shownParam(null, 'ar', true)).toBeNull();
    expect(shownParam(undefined, 'ar', true)).toBeUndefined();
  });
});

describe('formatMessage', () => {
  it('fills placeholders, a missing one empty', () => {
    expect(formatMessage('en', 'Sent to {to} by {from}', { to: 'Ana', from: 'Bo' })).toBe(
      'Sent to Ana by Bo',
    );
    expect(formatMessage('en', 'From { name }.', { name: 'Ana' })).toBe('From Ana.');
    expect(formatMessage('en', 'Hello {name}!')).toBe('Hello !');
  });

  it('shows numbers and text as the web app does', () => {
    expect(formatMessage('de', '{total} Artikel', { total: 1234 })).toBe('1.234 Artikel');
    expect(formatMessage('en', 'In {feed}', { feed: 'חדשות' })).toBe('In \u2068חדשות\u2069');
  });

  it('shows literals as their text', () => {
    expect(
      formatMessage('en', "{'@'}{name} {'|'} {'{'}x{'}'} {'\\''} {'\\u00e9'}", { name: 'a' }),
    ).toBe("@a | {x} ' é");
  });

  it('picks the plural form by the count, which fills count and n', () => {
    const message = '{count} unread entry | {n} unread entries';
    expect([0, 1, 2, 1000].map((count) => formatMessage('en', message, { count }))).toEqual([
      '0 unread entries',
      '1 unread entry',
      '2 unread entries',
      '1,000 unread entries',
    ]);
    expect(formatMessage('en', message, { n: 1 })).toBe('1 unread entry');
  });

  it('picks plural forms in each language', () => {
    const cases = {
      de: '{count} ungelesener Artikel | {count} ungelesene Artikel',
      es: '{count} artículo sin leer | {count} artículos sin leer',
      it: '{count} articolo da leggere | {count} articoli da leggere',
    };
    expect(
      Object.entries(cases).map(([code, message]) =>
        [1, 2, 1_000_000].map((count) => formatMessage(code, message, { count })),
      ),
    ).toEqual([
      ['1 ungelesener Artikel', '2 ungelesene Artikel', '1.000.000 ungelesene Artikel'],
      ['1 artículo sin leer', '2 artículos sin leer', '1.000.000 artículos sin leer'],
      ['1 articolo da leggere', '2 articoli da leggere', '1.000.000 articoli da leggere'],
    ]);
  });

  it('keeps spaces that are not beside a separator', () => {
    expect(formatMessage('en', ' one | many ', { count: 1 })).toBe(' one');
    expect(formatMessage('en', ' one | many ', { count: 2 })).toBe('many ');
    expect(formatMessage('en', ' plain ')).toBe(' plain ');
  });

  it('picks forms by the language the message is written in', () => {
    // A language with a form English lacks, showing an English message not yet translated.
    expect(formatMessage('ar', 'one | other', { count: 2 }, 'en')).toBe('other');
    expect(formatMessage('de', '{count} entry | {count} entries', { count: 1000 }, 'en')).toBe(
      '1.000 entries',
    );
  });

  it('shows the first form without a count, and the default rule for another language', () => {
    expect(formatMessage('en', 'one | many')).toBe('one');
    expect(formatMessage('fr', 'one | many', { count: 2 })).toBe('many');
  });
});
