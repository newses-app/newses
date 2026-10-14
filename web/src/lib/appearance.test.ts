import type { ThemeTokens } from '@newses/shared';
import { BUILTIN_THEMES, DEFAULT_PREFS } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  MIN_CONTRAST,
  MIN_GRAPHIC_CONTRAST,
  mergeTokens,
  resolveAppearance,
  themeTokens,
} from './appearance.ts';

const original = BUILTIN_THEMES.original;

describe('contrastRatio', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});

describe('built-in themes', () => {
  // Primary, error, and warning also colour text (links, status); star and success only icons.
  const text = ['text', 'primary', 'error', 'warning'] as const;
  const graphics = ['star', 'success'] as const;

  for (const [key, tokens] of Object.entries(BUILTIN_THEMES))
    for (const mode of ['light', 'dark'] as const)
      it(`${key} ${mode} meets WCAG AA`, () => {
        const palette = tokens.palette[mode];
        for (const ground of [palette.background, palette.surface]) {
          for (const color of text)
            expect(contrastRatio(palette[color], ground), color).toBeGreaterThanOrEqual(
              MIN_CONTRAST,
            );
          for (const color of graphics)
            expect(contrastRatio(palette[color], ground), color).toBeGreaterThanOrEqual(
              MIN_GRAPHIC_CONTRAST,
            );
        }
      });
});

describe('mergeTokens', () => {
  it('applies layers in order, merging palettes and effects', () => {
    const merged = mergeTokens(
      original,
      { density: 'compact', palette: { light: { primary: '#111111', star: '#222222' } } },
      { density: 'comfortable', palette: { light: { primary: '#333333' } } },
      { effects: { texture: true } },
    );
    expect(merged.density).toBe('comfortable');
    expect(merged.palette.light).toEqual({
      ...original.palette.light,
      primary: '#333333',
      star: '#222222',
    });
    expect(merged.palette.dark).toEqual(original.palette.dark);
    expect(merged.effects).toEqual({ texture: true, animation: false });
  });

  it('leaves the base untouched', () => {
    const before = structuredClone(original);
    mergeTokens(original, { palette: { light: { primary: '#000000' } } });
    expect(original).toEqual(before);
  });
});

describe('themeTokens', () => {
  const prefs = { appearanceTheme: DEFAULT_PREFS.appearanceTheme, themeAdjustments: {} };
  const custom = { base: 'original' as const, tokens: { radius: 'none' as const, fontScale: 1.1 } };

  it('resolves a built-in theme', () => {
    expect(themeTokens(prefs)).toEqual(original);
  });

  it('resolves a custom theme as its base, its overrides, then the adjustments', () => {
    const tokens = themeTokens(
      { appearanceTheme: 7, themeAdjustments: { fontScale: 1.25 } },
      (id) => (id === 7 ? custom : undefined),
    );
    expect(tokens).toEqual({ ...original, radius: 'none', fontScale: 1.25 });
  });

  it('falls back to Original for a theme that no longer resolves', () => {
    expect(themeTokens({ appearanceTheme: 8, themeAdjustments: {} }, () => undefined)).toEqual(
      original,
    );
    expect(
      themeTokens({
        appearanceTheme: 'retired' as typeof prefs.appearanceTheme,
        themeAdjustments: {},
      }),
    ).toEqual(original);
  });
});

describe('resolveAppearance', () => {
  it('reproduces the original look', () => {
    const appearance = resolveAppearance(original);
    expect(appearance.themes.light.colors).toMatchObject({
      background: '#ffffff',
      'on-surface': '#000000',
      primary: '#b35900',
      star: '#b45309',
    });
    expect(appearance.themes.dark.colors).toMatchObject({
      background: '#121212',
      surface: '#212121',
      primary: '#ff9a3c',
    });
    expect(appearance.themes.dark.variables['border-color']).toBe('#ffffff');
    expect(appearance.defaults).toEqual({ global: {} });
    expect(appearance.variables).toEqual({ '--v-font-body': '', '--ui-font-scale': '1' });
    expect(appearance.attributes).toEqual({ 'data-theme-style': 'standard', 'data-effects': '' });
  });

  it('maps shape tokens to Vuetify defaults', () => {
    const tokens: ThemeTokens = {
      ...original,
      radius: 'none',
      density: 'compact',
      border: 'thin',
      elevation: 'flat',
    };
    const { defaults } = resolveAppearance(tokens);
    expect(defaults.global).toEqual({ rounded: 0, density: 'compact', elevation: 0 });
    expect(defaults.VCard).toEqual({ border: 'sm' });
    expect(resolveAppearance({ ...tokens, border: 'thick' }).defaults.VAppBar).toEqual({
      border: 'md',
    });
  });

  it('sets fonts, scale, style, and effects on the document root', () => {
    const appearance = resolveAppearance({
      ...original,
      style: 'terminal',
      uiFont: 'mono',
      fontScale: 1.125,
      effects: { texture: true, animation: true },
    });
    expect(appearance.variables['--v-font-body']).toMatch(/monospace$/);
    expect(appearance.variables['--ui-font-scale']).toBe('1.125');
    expect(appearance.attributes).toEqual({
      'data-theme-style': 'terminal',
      'data-effects': 'texture animation',
    });
  });
});
