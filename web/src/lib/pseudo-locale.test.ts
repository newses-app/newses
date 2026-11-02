import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import { pseudoMessages } from './pseudo-locale.ts';

const leaves = (node: object): string[] =>
  Object.values(node).flatMap((value: string | object) =>
    typeof value === 'string' ? [value] : leaves(value),
  );

describe('pseudoMessages', () => {
  it('accents and lengthens text', () => {
    expect(pseudoMessages('en-XA', { title: 'Saved' })).toEqual({ title: '⟦Šávéd~~⟧' });
  });

  it('forces each word right to left', () => {
    expect(pseudoMessages('ar-XB', { title: 'Two words' })).toEqual({
      title: '\u200F\u202ETwo\u202C\u200F \u200F\u202Ewords\u202C\u200F',
    });
  });

  it('keeps placeholders, literals, and plural separators', () => {
    const message = "{n} of {total} {'@'} home | one";
    for (const code of ['en-XA', 'ar-XB']) {
      const { text } = pseudoMessages(code, { text: message });
      expect(text).toContain('{n}');
      expect(text).toContain('{total}');
      expect(text).toContain("{'@'}");
      expect(text.split('|')).toHaveLength(2);
    }
  });

  it('changes every message but keeps its structure', () => {
    const pseudo = pseudoMessages('en-XA', en);
    expect(leaves(pseudo)).toHaveLength(leaves(en).length);
    expect(Object.keys(pseudo)).toEqual(Object.keys(en));
  });
});
