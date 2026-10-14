import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from './prefs-defaults.ts';
import { updatePrefsRequestSchema } from './prefs.ts';
import { BUILTIN_THEMES } from './themes-builtin.ts';
import { partialThemeTokensSchema, themeTokensSchema } from './themes.ts';

describe('theme tokens', () => {
  it('has valid built-in themes', () => {
    for (const tokens of Object.values(BUILTIN_THEMES))
      expect(themeTokensSchema.parse(tokens)).toEqual(tokens);
  });

  it('takes colours as #rrggbb only', () => {
    for (const primary of ['#B35900', '#b35900'])
      expect(partialThemeTokensSchema.safeParse({ palette: { light: { primary } } }).success).toBe(
        true,
      );
    for (const primary of ['red', '#fff', '#b35900ff', 'rgb(0, 0, 0)', 'var(--x)', ''])
      expect(partialThemeTokensSchema.safeParse({ palette: { light: { primary } } }).success).toBe(
        false,
      );
  });

  it('takes partial tokens at any depth', () => {
    for (const valid of [
      {},
      { fontScale: 1.1 },
      { palette: {} },
      { palette: { dark: { background: '#000000' } } },
      { effects: { texture: true } },
    ])
      expect(partialThemeTokensSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unknown keys and out-of-range values at any depth', () => {
    for (const invalid of [
      { colour: '#000000' },
      { palette: { sepia: {} } },
      { palette: { light: { link: '#000000' } } },
      { effects: { sparkles: true } },
      { fontScale: 0.5 },
      { fontScale: 2 },
      { uiFont: 'Comic Sans MS' },
      { style: 'neon' },
    ])
      expect(partialThemeTokensSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires every token in a full theme', () => {
    const { effects: _, ...missing } = BUILTIN_THEMES.original;
    expect(themeTokensSchema.safeParse(missing).success).toBe(false);
  });
});

describe('appearance preferences', () => {
  it('defaults to Original without adjustments', () => {
    expect(DEFAULT_PREFS.appearanceTheme).toBe('original');
    expect(DEFAULT_PREFS.themeAdjustments).toEqual({});
  });

  it('references a built-in key or a custom theme id', () => {
    for (const appearanceTheme of ['original', 1, 42])
      expect(updatePrefsRequestSchema.safeParse({ appearanceTheme }).success).toBe(true);
    for (const appearanceTheme of ['sepia', 0, -1, 1.5, '1', null])
      expect(updatePrefsRequestSchema.safeParse({ appearanceTheme }).success).toBe(false);
  });

  it('validates adjustments as partial tokens', () => {
    expect(
      updatePrefsRequestSchema.safeParse({ themeAdjustments: { density: 'compact' } }).success,
    ).toBe(true);
    expect(updatePrefsRequestSchema.safeParse({ themeAdjustments: { css: 'x' } }).success).toBe(
      false,
    );
  });
});
