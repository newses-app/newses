import { describe, expect, it } from 'vitest';
import { pluralRule } from './plurals.ts';

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
