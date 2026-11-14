import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { mount, type ComponentMountingOptions } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import { type Component, defineComponent, h } from 'vue';
import { i18n, vuetifyLocale } from '../plugins/i18n.ts';

/** Mounts a component with the app's i18n messages and Vuetify, as the app installs them. */
export function mountWithPlugins<C extends Component>(
  component: C,
  options: ComponentMountingOptions<C> = {},
) {
  return mount(component, {
    ...options,
    global: {
      ...options.global,
      plugins: [i18n, createVuetify({ locale: vuetifyLocale }), ...(options.global?.plugins ?? [])],
    },
  });
}

/**
 * Runs a composable in a mounted component, with the app's plugins, a fresh Pinia, and Vue Query
 * (`queryClient`, or a new one that does not retry). Unmount the wrapper to run its cleanup.
 */
export function withSetup<T>(
  composable: () => T,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  let result!: T;
  const wrapper = mountWithPlugins(
    defineComponent({
      setup() {
        result = composable();
        return () => h('div');
      },
    }),
    { global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] } },
  );
  return { result, wrapper, queryClient, pinia };
}
