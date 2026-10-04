import { aliases, mdi } from 'vuetify/iconsets/mdi-svg';
import { createVuetify } from 'vuetify';
import 'vuetify/styles';

export const vuetify = createVuetify({
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    defaultTheme: 'system',
    themes: {
      light: { colors: { primary: '#c25e00' } },
      dark: { colors: { primary: '#ff9a3c' } },
    },
  },
  defaults: {
    VBtn: { variant: 'text' },
    VTextField: { variant: 'outlined', density: 'comfortable' },
    VSelect: { variant: 'outlined', density: 'comfortable' },
  },
});
