import { z } from 'zod';
import {
  FONT_KEYS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  THEME_BORDERS,
  THEME_DENSITIES,
  THEME_ELEVATIONS,
  THEME_RADII,
  THEME_STYLES,
} from './themes-builtin.ts';

const color = z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a #rrggbb colour');

const paletteShape = {
  background: color,
  surface: color,
  /** Text and icons on the background and surface. */
  text: color,
  primary: color,
  /** The star icon. */
  star: color,
  error: color,
  warning: color,
  success: color,
};

const effectsShape = {
  /** A background texture: scanlines, paper. */
  texture: z.boolean(),
  /** Decorative animation, such as a blinking cursor; never under reduced motion. */
  animation: z.boolean(),
};

const tokensShape = {
  style: z.enum(THEME_STYLES),
  /** Colours for the light and dark modes. */
  palette: z.strictObject({
    light: z.strictObject(paletteShape),
    dark: z.strictObject(paletteShape),
  }),
  uiFont: z.enum(FONT_KEYS),
  articleFont: z.enum(FONT_KEYS),
  fontScale: z.number().min(MIN_FONT_SCALE).max(MAX_FONT_SCALE),
  radius: z.enum(THEME_RADII),
  density: z.enum(THEME_DENSITIES),
  border: z.enum(THEME_BORDERS),
  elevation: z.enum(THEME_ELEVATIONS),
  effects: z.strictObject(effectsShape),
};

export const themeTokensSchema = z.strictObject(tokensShape);

const partialPaletteSchema = z.strictObject(paletteShape).partial();

/** Overrides of some tokens, to any depth; unknown keys are rejected rather than kept. */
export const partialThemeTokensSchema = z
  .strictObject({
    ...tokensShape,
    palette: z.strictObject({ light: partialPaletteSchema, dark: partialPaletteSchema }).partial(),
    effects: z.strictObject(effectsShape).partial(),
  })
  .partial();

export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export type PartialThemeTokens = z.infer<typeof partialThemeTokensSchema>;
export type ThemePalette = ThemeTokens['palette']['light'];
export type FontKey = ThemeTokens['uiFont'];
