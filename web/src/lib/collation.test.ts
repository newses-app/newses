import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../plugins/i18n.ts';
import { compareTitles } from './collation.ts';

afterEach(() => {
  i18n.global.locale.value = 'en';
});

describe('compareTitles', () => {
  it('ignores case and accents', () => {
    expect(compareTitles('apple', 'APPLE')).toBe(0);
    expect(compareTitles('resume', 'résumé')).toBe(0);
  });

  it("sorts by the app's language, not the browser's", () => {
    const titles = ['ñu', 'nz', 'oz'];
    expect([...titles].sort(compareTitles)).toEqual(['ñu', 'nz', 'oz']);
    i18n.global.locale.value = 'es';
    expect([...titles].sort(compareTitles)).toEqual(['nz', 'ñu', 'oz']);
  });
});
