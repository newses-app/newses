import type { PartialThemeTokens, ThemeTokens } from '@newses/shared';
import { BUILTIN_THEMES } from '@newses/shared/client';
import { computed, shallowRef, watch, watchEffect } from 'vue';
import { useTheme } from 'vuetify';
import { type Appearance, mergeTokens, resolveAppearance, themeTokens } from '../lib/appearance.ts';
import { readingStyle } from '../lib/reading.ts';
import { usePrefs } from './usePrefs.ts';

const CACHE_KEY = 'newses.appearance';

/** The theme's Vuetify defaults; App.vue provides them over the static ones. */
export const themeDefaults = shallowRef<Appearance['defaults']>({});

/** Adjustments being made, shown before they are saved. */
export const adjustmentsPreview = shallowRef<PartialThemeTokens | null>(null);

/** The theme applied at startup, kept until preferences load. */
let startupTokens: ThemeTokens = BUILTIN_THEMES.original;

/** The theme last applied on this device, so a reload starts with it rather than with Original. */
function cachedTokens(): ThemeTokens {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    // Over Original, so tokens added since it was cached take their defaults.
    if (cached) return mergeTokens(BUILTIN_THEMES.original, JSON.parse(cached) as ThemeTokens);
  } catch {
    // Storage blocked, or an unreadable entry.
  }
  return BUILTIN_THEMES.original;
}

function cacheTokens(tokens: ThemeTokens): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(tokens));
  } catch {
    // Storage blocked or full: the next reload starts with Original.
  }
}

/** Sets the theme's custom properties and attributes on the document root, and its defaults. */
function applyToDocument(appearance: Appearance): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(appearance.variables)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(appearance.attributes)) root.setAttribute(name, value);
  themeDefaults.value = appearance.defaults;
}

/** Applies the cached theme before mounting; returns it for Vuetify's initial themes. */
export function startAppearance(): Appearance {
  startupTokens = cachedTokens();
  const appearance = resolveAppearance(startupTokens);
  applyToDocument(appearance);
  return appearance;
}

/** Applies the reader's theme, mode, and reading preferences while signed in. */
export function useAppearance(): void {
  const theme = useTheme();
  const { prefs, loaded } = usePrefs();
  const tokens = computed(() =>
    loaded.value
      ? themeTokens({
          appearanceTheme: prefs.value.appearanceTheme,
          themeAdjustments: adjustmentsPreview.value ?? prefs.value.themeAdjustments,
        })
      : startupTokens,
  );

  watchEffect(() => {
    if (loaded.value) void theme.change(prefs.value.theme);
  });
  // Vuetify's light and dark themes change in place, so the mode and `system` keep working.
  watch(
    tokens,
    (current) => {
      const appearance = resolveAppearance(current);
      for (const mode of ['light', 'dark'] as const) {
        const target = theme.themes.value[mode];
        if (!target) continue;
        Object.assign(target.colors, appearance.themes[mode].colors);
        Object.assign(target.variables, appearance.themes[mode].variables);
      }
      applyToDocument(appearance);
      // Only saved adjustments, so a reload never starts with ones that were not kept.
      if (adjustmentsPreview.value === null) cacheTokens(current);
    },
    { immediate: true },
  );
  watchEffect(() => {
    for (const [name, value] of Object.entries(readingStyle(prefs.value, tokens.value)))
      document.documentElement.style.setProperty(name, value);
  });
}
