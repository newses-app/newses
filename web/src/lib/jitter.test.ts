import { describe, expect, it } from 'vitest';
import { type JitterLetter, jitterLetters } from './jitter.ts';

const letters = (text: string): JitterLetter[] =>
  (jitterLetters(text) ?? []).flatMap((part) => (typeof part === 'string' ? [] : part));

describe('jitterLetters', () => {
  it('sets each letter apart, keeping words and the space between them', () => {
    const parts = jitterLetters('Case  file');
    expect(
      parts?.map((part) => (typeof part === 'string' ? part : part.map((l) => l.text))),
    ).toEqual([['C', 'a', 's', 'e'], '  ', ['f', 'i', 'l', 'e']]);
    expect(letters('Case  file').map((letter) => letter.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('jitters each letter by small amounts, the same every time', () => {
    const first = letters('Ελληνικά, кириллица, and Latin 42!');
    expect(first.every(({ y, rotate }) => Math.abs(y) <= 0.08 && Math.abs(rotate) <= 4)).toBe(true);
    expect(new Set(first.map(({ rotate }) => rotate)).size).toBeGreaterThan(1);
    expect(letters('Ελληνικά, кириллица, and Latin 42!')).toEqual(first);
  });

  it('keeps a grapheme together', () => {
    expect(letters('café 👩‍💻').map((letter) => letter.text)).toEqual(['c', 'a', 'f', 'é', '👩‍💻']);
  });

  it('leaves scripts whose letters join, and text without letters, as they are', () => {
    expect(jitterLetters('أخبار اليوم')).toBeNull();
    expect(jitterLetters('समाचार')).toBeNull();
    expect(jitterLetters('News हिन्दी')).toBeNull();
    expect(jitterLetters('  ')).toBeNull();
  });
});
