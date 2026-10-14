import { BUILTIN_THEMES, DEFAULT_PREFS } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import { readingStyle } from './reading.ts';

const original = BUILTIN_THEMES.original;

describe('readingStyle', () => {
  it('keeps the current look by default', () => {
    expect(readingStyle(DEFAULT_PREFS, original)).toEqual({
      '--article-font': 'inherit',
      '--article-font-size': '1rem',
      '--article-width': '50rem',
    });
  });

  it('maps fonts, sizes, and widths', () => {
    const style = readingStyle(
      { articleFont: 'serif', articleFontSize: 20, articleWidth: 'full' },
      original,
    );
    expect(style['--article-font']).toMatch(/serif$/);
    expect(style['--article-font-size']).toBe('1.25rem');
    expect(style['--article-width']).toBe('none');
  });

  it("uses the theme's article font unless the reader picks one", () => {
    const theme = { ...original, articleFont: 'mono' as const };
    expect(readingStyle(DEFAULT_PREFS, theme)['--article-font']).toMatch(/monospace$/);
    expect(
      readingStyle({ ...DEFAULT_PREFS, articleFont: 'serif' }, theme)['--article-font'],
    ).toMatch(/serif$/);
  });

  it("keeps the reader's text size under the theme's font scale", () => {
    expect(readingStyle(DEFAULT_PREFS, { ...original, fontScale: 1.25 })).toMatchObject({
      '--article-font-size': '0.8rem',
    });
  });
});
