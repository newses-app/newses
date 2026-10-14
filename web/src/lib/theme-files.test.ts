import { MAX_THEME_NAME_LENGTH } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import { readThemeFile, themeFile, themeFileName, uniqueName } from './theme-files.ts';

const theme = {
  name: 'Dusk',
  base: 'terminal' as const,
  tokens: { palette: { dark: { primary: '#ff8800' } }, density: 'compact' as const },
};

describe('theme files', () => {
  it('round-trips a theme', () => {
    const text = themeFile(theme);
    expect(JSON.parse(text)).toEqual({ format: 'newses-theme', version: 1, ...theme });
    expect(readThemeFile(text)).toEqual(theme);
  });

  it('rejects files that are not themes, leaving token checks to the server', () => {
    for (const text of [
      'not json',
      '[]',
      JSON.stringify({ ...theme }),
      JSON.stringify({ format: 'newses-theme', version: 2, ...theme }),
      JSON.stringify({ format: 'newses-theme', version: 1, name: 3, base: 'original', tokens: {} }),
      JSON.stringify({ format: 'newses-theme', version: 1, name: 'x', base: 'original' }),
    ])
      expect(readThemeFile(text)).toBeNull();
    expect(
      readThemeFile(
        JSON.stringify({ format: 'newses-theme', version: 1, name: 'x', base: 'neon', tokens: {} }),
      ),
    ).toEqual({ name: 'x', base: 'neon', tokens: {} });
  });

  it('names files after the theme', () => {
    expect(themeFileName('Late Night: Amber!')).toBe('late-night-amber.newses-theme.json');
    expect(themeFileName('Café')).toBe('café.newses-theme.json');
    expect(themeFileName('***')).toBe('theme.newses-theme.json');
  });
});

describe('uniqueName', () => {
  it('numbers names already taken, ignoring case', () => {
    expect(uniqueName('Dusk', [])).toBe('Dusk');
    expect(uniqueName(' Dusk ', ['dusk', 'Dusk 2'])).toBe('Dusk 3');
  });

  it('keeps within the length limit', () => {
    const long = 'x'.repeat(MAX_THEME_NAME_LENGTH + 5);
    expect(uniqueName(long, [])).toHaveLength(MAX_THEME_NAME_LENGTH);
    const numbered = uniqueName(long, ['x'.repeat(MAX_THEME_NAME_LENGTH)]);
    expect(numbered).toHaveLength(MAX_THEME_NAME_LENGTH);
    expect(numbered.endsWith(' 2')).toBe(true);
  });
});
