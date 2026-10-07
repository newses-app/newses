import { describe, expect, it } from 'vitest';
import { isHighScore, parseScore } from './score.ts';

describe('parseScore', () => {
  it('accepts whole numbers within range, including a typographic minus', () => {
    expect(parseScore('120')).toBe(120);
    expect(parseScore(' -500 ')).toBe(-500);
    expect(parseScore('−500')).toBe(-500);
    expect(parseScore(-1_000_000)).toBe(-1_000_000);
  });

  it('refuses blanks, fractions, text, and out-of-range values', () => {
    for (const text of ['', ' ', '1.5', 'ten', '1000001', '-1e7'])
      expect(parseScore(text)).toBeNull();
  });
});

describe('isHighScore', () => {
  it('highlights scores above the threshold, never unscored entries', () => {
    expect(isHighScore(1, 0)).toBe(true);
    expect(isHighScore(0, -10)).toBe(false);
    expect(isHighScore(-5, -10)).toBe(true);
    expect(isHighScore(100, 100)).toBe(false);
  });
});
