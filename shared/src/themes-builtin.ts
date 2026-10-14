import type { ThemeTokens } from './themes.ts';

// Theme token values and the built-in themes; no Zod, so browsers can import them.

/** `standard` is plain Vuetify; the others add a stylesheet scoped to `data-theme-style`. */
export const THEME_STYLES = ['standard', 'terminal', 'sketch'] as const;
/**
 * Font keys, never font-family text. `default` is the app's font; for articles, the UI font.
 * `patrickHand` and `plexMono` are bundled with the app.
 */
export const FONT_KEYS = ['default', 'sans', 'serif', 'mono', 'patrickHand', 'plexMono'] as const;
/** Corner rounding; `default` keeps each component's own. */
export const THEME_RADII = ['default', 'none', 'small', 'large'] as const;
/** `default` keeps each component's own density. */
export const THEME_DENSITIES = ['default', 'comfortable', 'compact'] as const;
/** Borders on the app's chrome: cards, toolbars, and drawers. */
export const THEME_BORDERS = ['none', 'thin', 'thick'] as const;
/** `flat` removes shadows. */
export const THEME_ELEVATIONS = ['default', 'flat'] as const;
/** Scale of the UI text; article text keeps the reader's size. */
export const MIN_FONT_SCALE = 0.875;
export const MAX_FONT_SCALE = 1.25;

export const BUILTIN_THEME_KEYS = ['original'] as const;
export type BuiltinThemeKey = (typeof BUILTIN_THEME_KEYS)[number];

/** Each palette meets WCAG AA on its background and surface: text 4.5:1, icons 3:1. */
export const BUILTIN_THEMES: Record<BuiltinThemeKey, ThemeTokens> = {
  original: {
    style: 'standard',
    palette: {
      light: {
        background: '#ffffff',
        surface: '#ffffff',
        text: '#000000',
        primary: '#b35900',
        star: '#b45309',
        error: '#b00020',
        warning: '#b45309',
        success: '#388e3c',
      },
      dark: {
        background: '#121212',
        surface: '#212121',
        text: '#ffffff',
        primary: '#ff9a3c',
        star: '#ffca28',
        error: '#d16b7e',
        warning: '#fb8c00',
        success: '#4caf50',
      },
    },
    uiFont: 'default',
    articleFont: 'default',
    fontScale: 1,
    radius: 'default',
    density: 'default',
    border: 'none',
    elevation: 'default',
    effects: { texture: false, animation: false },
  },
};
