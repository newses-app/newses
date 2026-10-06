import { aliases, mdi } from 'vuetify/iconsets/mdi-svg';
import { createVuetify } from 'vuetify';
import 'vuetify/styles';

// Light colours keep WCAG AA contrast on white and on selected-row backgrounds: text at least
// 4.5:1, icons (`star`) at least 3:1.
export const vuetify = createVuetify({
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    defaultTheme: 'system',
    themes: {
      light: {
        colors: { primary: '#b35900', warning: '#b45309', star: '#b45309' },
        variables: { 'medium-emphasis-opacity': 0.72 },
      },
      dark: { colors: { primary: '#ff9a3c', star: '#ffca28' } },
    },
  },
  defaults: {
    VBtn: { variant: 'text' },
    VTextField: { variant: 'outlined', density: 'comfortable' },
    VSelect: { variant: 'outlined', density: 'comfortable' },
  },
});
