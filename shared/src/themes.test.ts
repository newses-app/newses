import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from './prefs-defaults.ts';
import { updatePrefsRequestSchema } from './prefs.ts';
import { API_VERSION } from './api-version.ts';
import {
  BUILTIN_THEME_API_MINOR,
  BUILTIN_THEMES,
  THEME_STYLE_API_MINOR,
} from './themes-builtin.ts';
import { partialThemeTokensSchema, themeTokensSchema } from './themes.ts';

describe('theme tokens', () => {
  it('has valid built-in themes', () => {
    for (const tokens of Object.values(BUILTIN_THEMES))
      expect(themeTokensSchema.parse(tokens)).toEqual(tokens);
  });

  it('dates built-in themes and styles no later than this API version', () => {
    for (const [key, minor] of Object.entries({
      ...BUILTIN_THEME_API_MINOR,
      ...THEME_STYLE_API_MINOR,
    }))
      expect(minor, key).toBeLessThanOrEqual(API_VERSION.minor);
    for (const [key, tokens] of Object.entries(BUILTIN_THEMES))
      expect(THEME_STYLE_API_MINOR[tokens.style], key).toBeLessThanOrEqual(
        BUILTIN_THEME_API_MINOR[key as keyof typeof BUILTIN_THEME_API_MINOR],
      );
  });

  it('keeps Amber monitor to warm colours, red to yellow, for reading at night', () => {
    // The HSL hue of `#rrggbb` in degrees; 0 for greys.
    const hue = (hex: string) => {
      const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      const max = Math.max(r, g, b);
      const range = max - Math.min(r, g, b);
      if (range === 0) return 0;
      const sector =
        max === r ? (g - b) / range : max === g ? (b - r) / range + 2 : (r - g) / range + 4;
      return (sector * 60 + 360) % 360;
    };
    for (const palette of Object.values(BUILTIN_THEMES.amber.palette))
      for (const [color, hex] of Object.entries(palette))
        expect(hue(hex), color).toBeLessThanOrEqual(60);
  });

  it('keeps E-ink to greys', () => {
    for (const palette of Object.values(BUILTIN_THEMES.eink.palette))
      for (const [color, hex] of Object.entries(palette))
        expect(hex, color).toMatch(/^#([0-9a-f]{2})\1\1$/);
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
