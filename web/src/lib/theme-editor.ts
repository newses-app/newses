// The theme editor's choices and checks (components/settings/AppearancePanel.vue).
import type {
  BuiltinThemeKey,
  CreateThemeRequest,
  PartialThemeTokens,
  Prefs,
  Theme,
  ThemePalette,
} from '@newses/shared';
import {
  BUILTIN_THEME_API_MINOR,
  BUILTIN_THEME_KEYS,
  BUILTIN_THEMES,
  FONT_API_MINOR,
  THEME_STYLE_API_MINOR,
} from '@newses/shared/client';
import {
  builtin,
  builtinKey,
  contrastIssues,
  type CustomTheme,
  mergeTokens,
} from './appearance.ts';

type Mode = 'light' | 'dark';

/** Whether the server accepts what came with API minor version `minor`. */
type Accepted = (minor: number) => boolean;

/** The adjustment that sets a palette colour in `mode`; null for anything but `#rrggbb`. */
export function paletteChange(
  mode: Mode,
  color: keyof ThemePalette,
  value: string,
): PartialThemeTokens | null {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  return { palette: { [mode]: { [color]: value.toLowerCase() } } };
}

/**
 * The theme in use as a base and overrides, which adjustments apply to: a built-in theme, the
 * custom theme `custom` finds, or Original when it is gone.
 */
export function editedTheme(
  reference: Prefs['appearanceTheme'],
  custom: (id: number) => CustomTheme | undefined,
): CustomTheme {
  if (typeof reference === 'string') return { base: builtinKey(reference), tokens: {} };
  return custom(reference) ?? { base: 'original', tokens: {} };
}

/** Whether any colour of the theme, light or dark, is below WCAG AA. */
export function hasLowContrast(theme: CustomTheme): boolean {
  const { palette } = mergeTokens(builtin(theme.base), theme.tokens);
  return (
    contrastIssues(palette.light, 'light').length + contrastIssues(palette.dark, 'dark').length > 0
  );
}

/**
 * The API minor version a token value came with; 0 for one this app does not know, as an imported
 * file's values are only checked by the server.
 */
const minorOf = (table: Partial<Record<string, number>>, value: string) => table[value] ?? 0;

/** Whether the server takes an imported theme: its base, style, and fonts are not newer. */
export function importAccepted(theme: CreateThemeRequest, accepted: Accepted): boolean {
  const { style, uiFont, articleFont } = theme.tokens;
  return (
    accepted(BUILTIN_THEME_API_MINOR[theme.base]) &&
    (style === undefined || accepted(minorOf(THEME_STYLE_API_MINOR, style))) &&
    [uiFont, articleFont].every(
      (font) => font === undefined || accepted(minorOf(FONT_API_MINOR, font)),
    )
  );
}

export interface ThemeOption {
  value: Prefs['appearanceTheme'];
  name: string;
  palette: ThemePalette;
  /** A custom theme's; built-in themes have none. */
  theme?: Theme;
}

export interface ThemeGroup {
  title: string;
  options: ThemeOption[];
}

/**
 * The themes to pick from, each shown in `mode`'s palette: the built-in ones the server accepts,
 * the reader's own, and those others shared; empty groups are left out.
 */
export function themeGroups(options: {
  themes: readonly Theme[];
  mode: Mode;
  accepted: Accepted;
  labels: {
    builtIn: string;
    mine: string;
    shared: string;
    theme: (key: BuiltinThemeKey) => string;
  };
}): ThemeGroup[] {
  const { themes, mode, accepted, labels } = options;
  const custom = (theme: Theme): ThemeOption => ({
    value: theme.id,
    name: theme.name,
    palette: mergeTokens(builtin(theme.base), theme.tokens).palette[mode],
    theme,
  });
  return [
    {
      title: labels.builtIn,
      options: BUILTIN_THEME_KEYS.filter((key) => accepted(BUILTIN_THEME_API_MINOR[key])).map(
        (key): ThemeOption => ({
          value: key,
          name: labels.theme(key),
          palette: BUILTIN_THEMES[key].palette[mode],
        }),
      ),
    },
    { title: labels.mine, options: themes.filter((theme) => theme.mine).map(custom) },
    { title: labels.shared, options: themes.filter((theme) => !theme.mine).map(custom) },
  ].filter((group) => group.options.length > 0);
}
