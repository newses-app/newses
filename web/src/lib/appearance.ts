import type {
  BuiltinThemeKey,
  PartialThemeTokens,
  Prefs,
  ThemePalette,
  ThemeTokens,
} from '@newses/shared';
import { BUILTIN_THEMES } from '@newses/shared/client';
import { FONTS } from './reading.ts';

/** WCAG 2 minimum contrast for normal text. */
export const MIN_CONTRAST = 4.5;
/** WCAG 2 minimum contrast for icons and other non-text graphics. */
export const MIN_GRAPHIC_CONTRAST = 3;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

type PaletteColor = keyof ThemePalette;
type Mode = 'light' | 'dark';

/**
 * The opacity of secondary text: Vuetify's medium emphasis of its high-emphasis text colour (the
 * light theme's medium emphasis is set in plugins/vuetify.ts).
 */
const MEDIUM_EMPHASIS: Record<Mode, number> = { light: 0.87 * 0.72, dark: 0.7 };

/** `#rrggbb` of `color` at `alpha` over `ground`. */
function blend(color: string, ground: string, alpha: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(color, i) * alpha + channel(ground, i) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * The least contrast each palette colour needs on the background and on the surface (WCAG AA).
 * Primary, error, and warning also colour text; star and success colour only icons.
 */
const PALETTE_CONTRAST: [PaletteColor, number][] = [
  ['text', MIN_CONTRAST],
  ['primary', MIN_CONTRAST],
  ['error', MIN_CONTRAST],
  ['warning', MIN_CONTRAST],
  ['star', MIN_GRAPHIC_CONTRAST],
  ['success', MIN_GRAPHIC_CONTRAST],
];

export interface ContrastIssue {
  color: PaletteColor;
  /** The lower of its contrast on the background and on the surface. */
  ratio: number;
  min: number;
}

/** The palette's colours whose contrast is below WCAG AA. */
export function contrastIssues(palette: ThemePalette, mode: Mode): ContrastIssue[] {
  return PALETTE_CONTRAST.flatMap(([color, min]) => {
    // Text is checked as secondary text shows it, faded to medium emphasis over each ground.
    const ratio = Math.min(
      ...[palette.background, palette.surface].map((ground) =>
        contrastRatio(
          color === 'text' ? blend(palette.text, ground, MEDIUM_EMPHASIS[mode]) : palette[color],
          ground,
        ),
      ),
    );
    return ratio < min ? [{ color, ratio, min }] : [];
  });
}

/** Whether `#rrggbb` is dark: light text and icons contrast with it more than dark ones. */
export function isDark(hex: string): boolean {
  return contrastRatio(hex, '#ffffff') > contrastRatio(hex, '#000000');
}

/** A custom theme: a built-in theme with some tokens overridden. */
export interface CustomTheme {
  base: BuiltinThemeKey;
  tokens: PartialThemeTokens;
}

/** `base` with the values `layer` sets; parsed JSON has no `undefined`, but the types allow it. */
function assign<T extends object>(
  base: T,
  layer: { [K in keyof T]?: T[K] | undefined } | undefined,
): T {
  const result = { ...base };
  for (const [key, value] of Object.entries(layer ?? {}))
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  return result;
}

/** Applies each layer of overrides in turn, so later layers win. */
export function mergeTokens(base: ThemeTokens, ...layers: PartialThemeTokens[]): ThemeTokens {
  return layers.reduce<ThemeTokens>(
    (tokens, { palette, effects, ...rest }) => ({
      ...assign(tokens, rest),
      palette: {
        light: assign(tokens.palette.light, palette?.light),
        dark: assign(tokens.palette.dark, palette?.dark),
      },
      effects: assign(tokens.effects, effects),
    }),
    base,
  );
}

type PartialPalette = NonNullable<NonNullable<PartialThemeTokens['palette']>['light']>;

/** The reader's adjustments with `change` added; palettes and effects merge. */
export function mergeAdjustments(
  adjustments: PartialThemeTokens,
  change: PartialThemeTokens,
): PartialThemeTokens {
  const { palette, effects, ...rest } = change;
  const merged = assign(adjustments, rest);
  if (palette) {
    merged.palette = { ...adjustments.palette };
    for (const mode of ['light', 'dark'] as const)
      if (palette[mode])
        merged.palette[mode] = assign<PartialPalette>(
          adjustments.palette?.[mode] ?? {},
          palette[mode],
        );
  }
  if (effects) merged.effects = assign(adjustments.effects ?? {}, effects);
  return merged;
}

const builtin = (key: string): ThemeTokens =>
  Object.hasOwn(BUILTIN_THEMES, key)
    ? BUILTIN_THEMES[key as BuiltinThemeKey]
    : BUILTIN_THEMES.original;

/**
 * The reader's theme: its base, then its overrides, then the reader's adjustments. A reference
 * that no longer resolves (a deleted or unpublished theme) shows Original.
 */
export function themeTokens(
  prefs: Pick<Prefs, 'appearanceTheme' | 'themeAdjustments'>,
  custom: (id: number) => CustomTheme | undefined = () => undefined,
): ThemeTokens {
  const reference = prefs.appearanceTheme;
  if (typeof reference === 'string') return mergeTokens(builtin(reference), prefs.themeAdjustments);
  const theme = custom(reference);
  return mergeTokens(
    builtin(theme?.base ?? 'original'),
    theme?.tokens ?? {},
    prefs.themeAdjustments,
  );
}

/** What applying a theme sets: Vuetify's themes and defaults, and the document root's styles. */
export interface Appearance {
  /** Merged into Vuetify's `light` and `dark` theme definitions. */
  themes: Record<Mode, { colors: Record<string, string>; variables: Record<string, string> }>;
  /** Vuetify defaults provided over the static ones. */
  defaults: Record<string, Record<string, unknown>>;
  /** CSS custom properties on the document root; an empty value removes one. */
  variables: Record<string, string>;
  /** Attributes on the document root that theme stylesheets select on. */
  attributes: Record<'data-theme-style' | 'data-effects', string>;
}

const vuetifyTheme = (palette: ThemePalette) => ({
  colors: {
    background: palette.background,
    surface: palette.surface,
    'on-background': palette.text,
    'on-surface': palette.text,
    primary: palette.primary,
    star: palette.star,
    error: palette.error,
    warning: palette.warning,
    success: palette.success,
  },
  variables: { 'border-color': palette.text },
});

const ROUNDED: Record<Exclude<ThemeTokens['radius'], 'default'>, number | string> = {
  none: 0,
  small: 'sm',
  large: 'lg',
};

const BORDER_WIDTHS: Record<ThemeTokens['border'], string> = {
  none: '0px',
  thin: '1px',
  thick: '2px',
};

/** Components that make up the app's chrome, which a theme's border outlines. */
const BORDERED = ['VAppBar', 'VCard', 'VNavigationDrawer', 'VToolbar'];

function vuetifyDefaults(tokens: ThemeTokens): Appearance['defaults'] {
  const global: Record<string, unknown> = {};
  if (tokens.radius !== 'default') global.rounded = ROUNDED[tokens.radius];
  if (tokens.density !== 'default') global.density = tokens.density;
  if (tokens.elevation === 'flat') global.elevation = 0;
  const defaults: Appearance['defaults'] = { global };
  if (tokens.border !== 'none') {
    const border = tokens.border === 'thin' ? 'sm' : 'md';
    for (const component of BORDERED) defaults[component] = { border };
  }
  return defaults;
}

/** Turns a theme's tokens into what the app applies. */
export function resolveAppearance(tokens: ThemeTokens): Appearance {
  return {
    themes: { light: vuetifyTheme(tokens.palette.light), dark: vuetifyTheme(tokens.palette.dark) },
    defaults: vuetifyDefaults(tokens),
    variables: {
      // Vuetify's own font unless the theme picks one.
      '--v-font-body': tokens.uiFont === 'default' ? '' : FONTS[tokens.uiFont],
      '--ui-font-scale': String(tokens.fontScale),
      '--theme-border-width': BORDER_WIDTHS[tokens.border],
    },
    attributes: {
      'data-theme-style': tokens.style,
      'data-effects': (Object.keys(tokens.effects) as (keyof ThemeTokens['effects'])[])
        .filter((effect) => tokens.effects[effect])
        .join(' '),
    },
  };
}
