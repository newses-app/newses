import { DEFAULT_PREFS } from '@rss-reader/shared/client';
import { describe, expect, it } from 'vitest';
import { readingStyle } from './reading.ts';

describe('readingStyle', () => {
  it('keeps the current look by default', () => {
    expect(readingStyle(DEFAULT_PREFS)).toEqual({
      '--article-font': 'inherit',
      '--article-font-size': '1rem',
      '--article-width': '50rem',
    });
  });

  it('maps fonts, sizes, and widths', () => {
    const style = readingStyle({ articleFont: 'serif', articleFontSize: 20, articleWidth: 'full' });
    expect(style['--article-font']).toMatch(/serif$/);
    expect(style['--article-font-size']).toBe('1.25rem');
    expect(style['--article-width']).toBe('none');
  });
});
