import { mdiArrowLeft, mdiChevronRight, mdiStar } from '@mdi/js';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import { aliases } from 'vuetify/iconsets/mdi-svg';
import { VIcon } from 'vuetify/components';
import { mirroringIcons } from './mirrored-icons.ts';

const icon = (name: string) =>
  mount(VIcon, {
    props: { icon: name },
    global: {
      plugins: [
        createVuetify({ icons: { defaultSet: 'mdi', aliases, sets: { mdi: mirroringIcons } } }),
      ],
    },
  });

describe('mirroringIcons', () => {
  it('marks icons that point along the reading direction', () => {
    expect(icon(mdiArrowLeft).find('.mirrored-icon').exists()).toBe(true);
    expect(icon(mdiChevronRight).classes()).toContain('mirrored-icon');
  });

  it('draws them as before', () => {
    expect(icon(mdiArrowLeft).find('path').attributes('d')).toBe(mdiArrowLeft);
    expect(icon(mdiArrowLeft).classes()).toContain('v-icon');
  });

  it('leaves other icons, and the aliases Vuetify flips itself, alone', () => {
    expect(icon(mdiStar).find('.mirrored-icon').exists()).toBe(false);
    expect(icon('$next').find('.mirrored-icon').exists()).toBe(false);
  });
});
