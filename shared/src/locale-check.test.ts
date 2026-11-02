import { describe, expect, it } from 'vitest';
import { localeProblems, messageEntries, missingKeys, pluralForms } from './locale-check.ts';

const source = {
  greeting: 'Hello {name}',
  items: 'one item | {n} items',
  nested: { plain: 'Saved' },
};
const translation = (overrides: object) => ({
  greeting: 'Hola {name}',
  items: 'un elemento | {n} elementos',
  nested: { plain: 'Guardado' },
  ...overrides,
});
const problems = (overrides: object, forms = 2) =>
  localeProblems(source, translation(overrides), forms);

describe('messageEntries', () => {
  it('flattens nested messages to dotted keys', () => {
    expect(messageEntries({ a: 'x', b: { c: 'y', d: { e: 'z' } } })).toEqual([
      ['a', 'x'],
      ['b.c', 'y'],
      ['b.d.e', 'z'],
    ]);
  });
});

describe('pluralForms', () => {
  it('takes a literal pipe as text', () => {
    expect(pluralForms("a {'|'} b")).toHaveLength(1);
    expect(pluralForms('a | b')).toHaveLength(2);
  });
});

describe('missingKeys', () => {
  it('lists what a language has yet to translate', () => {
    expect(missingKeys(source, { greeting: 'Hola {name}' })).toEqual(['items', 'nested.plain']);
  });
});

describe('localeProblems', () => {
  it('accepts a sound translation', () => {
    expect(problems({})).toEqual([]);
  });

  it('accepts a partial translation', () => {
    expect(localeProblems(source, { greeting: 'Hola {name}' }, 2)).toEqual([]);
  });

  it('accepts a plural form without the count, as the source language has', () => {
    expect(problems({ items: 'un elemento | {n} elementos' })).toEqual([]);
  });

  it.each([
    ['a stray @', { greeting: 'Hola {name} a@b' }],
    ['an unclosed brace', { greeting: 'Hola {name' }],
    ['a stray closing brace', { greeting: 'Hola {name} }' }],
  ])('finds a message that will not compile: %s', (_, overrides) => {
    expect(problems(overrides).length).toBeGreaterThan(0);
  });

  it('finds a key the source language does not have', () => {
    expect(problems({ retired: 'Viejo' })).toEqual(['retired: not in the source language']);
  });

  it('finds a renamed or lost placeholder', () => {
    expect(problems({ greeting: 'Hola {nombre}' })).toEqual([
      'greeting: placeholders differ from the source language',
    ]);
    expect(problems({ greeting: 'Hola' })).toEqual([
      'greeting: placeholders differ from the source language',
    ]);
  });

  it('finds blank messages and blank plural forms', () => {
    expect(problems({ nested: { plain: '  ' } })).toContain('nested.plain: blank text');
    expect(problems({ items: 'un elemento | ' })).toContain('items: blank text');
  });

  it('finds bidi control characters', () => {
    expect(problems({ nested: { plain: 'Guardado\u202E' } })).toEqual([
      'nested.plain: bidi control character',
    ]);
  });

  it('holds plural messages to the forms the language has', () => {
    expect(problems({ items: '{n} elementos' })).toEqual(['items: 1 plural forms, expected 2']);
    expect(problems({ items: 'a | b {n} | c' })).toEqual(['items: 3 plural forms, expected 2']);
    expect(problems({ items: 'a {n} | b | c' }, 3)).toEqual([]);
  });

  it('finds a pipe in a message that has no plural', () => {
    expect(problems({ nested: { plain: 'uno | dos' } })).toEqual([
      'nested.plain: plural forms in a plain message',
    ]);
  });

  it('leaves the source language its own number of forms', () => {
    expect(localeProblems({ done: 'none | one | {n}' }, { done: 'none | one | {n}' })).toEqual([]);
  });
});
