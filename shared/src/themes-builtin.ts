import type { ThemeTokens } from './themes.ts';

// Theme token values and the built-in themes; no Zod, so browsers can import them.

/** `standard` is plain Vuetify; the others add a stylesheet scoped to `data-theme-style`. */
export const THEME_STYLES = ['standard', 'terminal', 'sketch', 'eink'] as const;
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

export const BUILTIN_THEME_KEYS = [
  'original',
  'terminal',
  'sketch',
  'catppuccin',
  'solarized',
  'amber',
  'eink',
] as const;
export type BuiltinThemeKey = (typeof BUILTIN_THEME_KEYS)[number];

/** The API minor that added each built-in theme; older servers refuse its key. */
export const BUILTIN_THEME_API_MINOR: Record<BuiltinThemeKey, number> = {
  original: 0,
  terminal: 0,
  sketch: 0,
  catppuccin: 8,
  solarized: 8,
  amber: 8,
  eink: 8,
};
/** The API minor that added each style; older servers refuse tokens with it. */
export const THEME_STYLE_API_MINOR: Record<(typeof THEME_STYLES)[number], number> = {
  standard: 0,
  terminal: 0,
  sketch: 0,
  eink: 8,
};

/**
 * Each palette meets WCAG AA on its background and surface: text 4.5:1, also faded to secondary
 * text, and icons 3:1.
 */
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
  // A terminal: green phosphor on near-black, or dark ink on pale paper.
  terminal: {
    style: 'terminal',
    palette: {
      light: {
        background: '#f4f1e6',
        surface: '#faf8f0',
        text: '#0f1a0f',
        primary: '#1d6b2b',
        star: '#9a5b00',
        error: '#b3261e',
        warning: '#7f4c00',
        success: '#2e6b30',
      },
      dark: {
        background: '#0a0e0a',
        surface: '#0f160f',
        text: '#33ff66',
        primary: '#9cff57',
        star: '#ffb000',
        error: '#ff6e5a',
        warning: '#ffc23d',
        success: '#33ff66',
      },
    },
    uiFont: 'plexMono',
    articleFont: 'default',
    fontScale: 1,
    radius: 'none',
    density: 'compact',
    border: 'thin',
    elevation: 'flat',
    effects: { texture: true, animation: true },
  },
  // Hand-drawn: ink on paper, or chalk on a chalkboard.
  sketch: {
    style: 'sketch',
    palette: {
      light: {
        background: '#f8f4ea',
        surface: '#fffdf6',
        text: '#141a23',
        primary: '#1f4fa3',
        star: '#b95c00',
        error: '#b3261e',
        warning: '#8a5200',
        success: '#2e7d32',
      },
      dark: {
        background: '#22302a',
        surface: '#2a3a33',
        text: '#f2efe4',
        primary: '#9fd0ff',
        star: '#ffd666',
        error: '#ffa3a3',
        warning: '#ffc46b',
        success: '#a5e3a1',
      },
    },
    uiFont: 'patrickHand',
    articleFont: 'sans',
    // The handwriting font runs small.
    fontScale: 1.125,
    radius: 'default',
    density: 'default',
    border: 'thick',
    elevation: 'flat',
    effects: { texture: true, animation: false },
  },
  // Catppuccin (MIT): Latte by day, Mocha by night. Mocha is as published; Latte's text and
  // accents are darkened, keeping their hue, to the nearest shade that passes.
  catppuccin: {
    style: 'standard',
    palette: {
      light: {
        background: '#eff1f5',
        surface: '#e6e9ef',
        text: '#1a1b32',
        primary: '#8738ee',
        star: '#be7501',
        error: '#d10d38',
        warning: '#b64401',
        success: '#399923',
      },
      dark: {
        background: '#1e1e2e',
        surface: '#181825',
        text: '#cdd6f4',
        primary: '#cba6f7',
        star: '#f9e2af',
        error: '#f38ba8',
        warning: '#fab387',
        success: '#a6e3a1',
      },
    },
    uiFont: 'default',
    articleFont: 'default',
    fontScale: 1,
    radius: 'large',
    density: 'default',
    border: 'none',
    elevation: 'default',
    effects: { texture: false, animation: false },
  },
  // Solarized (MIT), light and dark. Text and accents are lightened in dark mode and darkened in
  // light mode, keeping their hue, to the nearest shade that passes.
  solarized: {
    style: 'standard',
    palette: {
      light: {
        background: '#fdf6e3',
        surface: '#eee8d5',
        text: '#0c2027',
        primary: '#026dad',
        star: '#a87f00',
        error: '#cd1e21',
        warning: '#bb3e01',
        success: '#7b8e00',
      },
      dark: {
        background: '#002b36',
        surface: '#073642',
        text: '#b7c9cb',
        primary: '#3f9fe7',
        star: '#b58900',
        error: '#ff665b',
        warning: '#f47142',
        success: '#859900',
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
  // Terminal in amber phosphor for reading at night: warm colours only, or amber-brown ink on paper.
  amber: {
    style: 'terminal',
    palette: {
      light: {
        background: '#f6efe0',
        surface: '#fbf7ee',
        text: '#241400',
        primary: '#8a4b00',
        star: '#a35d00',
        error: '#b3261e',
        warning: '#9a3a00',
        success: '#7a5800',
      },
      dark: {
        background: '#0d0a05',
        surface: '#16100a',
        text: '#ffb000',
        primary: '#ffd27a',
        star: '#ffe9b3',
        error: '#ff5a3c',
        warning: '#ff8c1a',
        success: '#ffb000',
      },
    },
    uiFont: 'plexMono',
    articleFont: 'default',
    fontScale: 1,
    radius: 'none',
    density: 'compact',
    border: 'thin',
    elevation: 'flat',
    effects: { texture: true, animation: true },
  },
  // For e-ink screens: black and white only, with nothing moving.
  eink: {
    style: 'eink',
    palette: {
      light: {
        background: '#ffffff',
        surface: '#ffffff',
        text: '#000000',
        primary: '#000000',
        star: '#000000',
        error: '#000000',
        warning: '#000000',
        success: '#000000',
      },
      dark: {
        background: '#000000',
        surface: '#000000',
        text: '#ffffff',
        primary: '#ffffff',
        star: '#ffffff',
        error: '#ffffff',
        warning: '#ffffff',
        success: '#ffffff',
      },
    },
    uiFont: 'default',
    articleFont: 'default',
    fontScale: 1,
    radius: 'none',
    density: 'default',
    border: 'thick',
    elevation: 'flat',
    effects: { texture: false, animation: false },
  },
};
