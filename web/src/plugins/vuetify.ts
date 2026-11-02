import { aliases } from 'vuetify/iconsets/mdi-svg';
import { createVuetify } from 'vuetify';
import 'vuetify/styles';
import type { Appearance } from '../lib/appearance.ts';
import { mirroringIcons } from '../lib/mirrored-icons.ts';
import { vuetifyLocale } from './i18n.ts';

/** Vuetify with the appearance theme's colours; signing in applies the reader's own. */
export function createAppVuetify(appearance: Appearance) {
  return createVuetify({
    locale: vuetifyLocale,
    icons: { defaultSet: 'mdi', aliases, sets: { mdi: mirroringIcons } },
    theme: {
      defaultTheme: 'system',
      themes: {
        light: {
          colors: appearance.themes.light.colors,
          variables: { 'medium-emphasis-opacity': 0.72, ...appearance.themes.light.variables },
        },
        dark: {
          colors: appearance.themes.dark.colors,
          variables: appearance.themes.dark.variables,
        },
      },
    },
    defaults: {
      VBtn: { variant: 'text' },
      VTextField: { variant: 'outlined', density: 'comfortable' },
      VSelect: { variant: 'outlined', density: 'comfortable' },
    },
  });
}
