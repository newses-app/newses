/* eslint-disable vue/one-component-per-file -- test wrappers around the component under test */
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { DOMWrapper, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import { VApp } from 'vuetify/components';
import { type Component, defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { i18n, vuetifyLocale } from '../plugins/i18n.ts';

// Vuetify's overlays (dialogs, menus) follow the visual viewport, which happy-dom lacks.
if (!('visualViewport' in globalThis)) {
  Object.defineProperty(globalThis, 'visualViewport', {
    value: Object.assign(new EventTarget(), {
      width: 1024,
      height: 768,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
    }),
    configurable: true,
  });
}

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
 * Mounts a component as the app runs it: with a fresh Pinia, Vue Query (`queryClient`, or a new
 * one that does not retry), and `router` when given, attached to the document so dialogs, which
 * render in an overlay there, can be found. Unmount the wrapper to detach it.
 */
export function mountInApp<C extends Component>(
  component: C,
  options: ComponentMountingOptions<C> & { queryClient?: QueryClient; router?: Router } = {},
) {
  const { queryClient: given, router, ...mounting } = options;
  const queryClient = given ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mountWithPlugins(component, {
    attachTo: document.body,
    ...mounting,
    global: {
      ...mounting.global,
      plugins: [
        pinia,
        [VueQueryPlugin, { queryClient }],
        ...(router ? [router] : []),
        ...(mounting.global?.plugins ?? []),
      ],
    },
  });
  return { wrapper, queryClient, pinia };
}

/** The open dialog (or other overlay matching `selector`), which renders outside the component. */
export function overlay(selector = '.v-dialog'): DOMWrapper<Element> {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No ${selector} open`);
  return new DOMWrapper(element);
}

/** The button in `within` whose text is `label`. */
export function button(
  within: DOMWrapper<Element> | { findAll(selector: 'button'): DOMWrapper<HTMLButtonElement>[] },
  label: string,
) {
  const found = within.findAll('button').find((b) => b.text() === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

/** A view in the app's layout (`v-app`), which `v-main` and app bars need. */
export const inLayout = (view: Component) =>
  defineComponent({ render: () => h(VApp, () => h(view)) });

/** A router with every path rendering nothing, at `path`, for components that link or navigate. */
export async function testRouter(path = '/', names: string[] = []) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      ...names.map((name) => ({ path: `/${name}`, name, component: { render: () => null } })),
      { path: '/:pathMatch(.*)*', component: { render: () => null } },
    ],
  });
  await router.push(path);
  return router;
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
