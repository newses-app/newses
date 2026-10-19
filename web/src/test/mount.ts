import { mount, type ComponentMountingOptions } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import type { Component } from 'vue';
import { i18n } from '../plugins/i18n.ts';

/** Mounts a component with the app's i18n messages and Vuetify, as the app installs them. */
export function mountWithPlugins<C extends Component>(
  component: C,
  options: ComponentMountingOptions<C> = {},
) {
  return mount(component, {
    ...options,
    global: {
      ...options.global,
      plugins: [i18n, createVuetify(), ...(options.global?.plugins ?? [])],
    },
  });
}
