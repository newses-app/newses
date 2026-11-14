/* eslint-disable vue/one-component-per-file -- the signed-in layout, and a page inside it */
import type { Prefs } from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import type { ShortcutAction } from '../lib/shortcuts.ts';
import { useShortcutHandler, useShortcutListener } from './useShortcuts.ts';

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { prefs: { get: () => new Promise(() => undefined) } },
}));

enableAutoUnmount(afterEach);

/** The signed-in layout's listener, with the reader's handler while `reader` is shown. */
function setup(prefs: Partial<Prefs> = {}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['prefs'], { ...DEFAULT_PREFS, keyboardShortcuts: true, ...prefs });
  const global = vi.fn((action: ShortcutAction) => action === 'search');
  const page = vi.fn((action: ShortcutAction) => action === 'nextArticle');
  const reader = ref(true);
  const Reader = defineComponent({
    setup() {
      useShortcutHandler(page);
      return () => h('div');
    },
  });
  const wrapper = mount(
    defineComponent({
      setup() {
        useShortcutListener(global);
        return () => h('div', reader.value ? [h(Reader)] : []);
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient }]] }, attachTo: document.body },
  );
  return { wrapper, global, page, reader, queryClient };
}

/** Presses a key on `target` (the page by default); returns whether it was handled. */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('useShortcutListener', () => {
  it("asks the page's handler first, then the global one, and takes the key when either acts", () => {
    const { global, page } = setup();
    expect(press('n')).toBe(true);
    expect(page).toHaveBeenLastCalledWith('nextArticle');
    expect(global).not.toHaveBeenCalled();

    expect(press('/')).toBe(true);
    expect(page).toHaveBeenLastCalledWith('search');
    expect(global).toHaveBeenLastCalledWith('search');

    expect(press('s')).toBe(false);
    expect(global).toHaveBeenLastCalledWith('toggleStar');
    expect(press('q')).toBe(false);
    expect(global).toHaveBeenCalledTimes(2);
  });

  it('matches chords and follows the reader’s bindings', async () => {
    const { global, queryClient } = setup();
    press('f');
    press('s');
    expect(global).toHaveBeenLastCalledWith('subscribe');

    queryClient.setQueryData(['prefs'], {
      ...DEFAULT_PREFS,
      keyboardShortcuts: true,
      shortcutBindings: { search: ['g'] },
    });
    await nextTick();
    press('g');
    expect(global).toHaveBeenLastCalledWith('search');
  });

  it('leaves keys alone with shortcuts off, with a command modifier, or once handled', () => {
    const { global, page } = setup({ keyboardShortcuts: false });
    press('n');
    const off = setup();
    press('n', { ctrlKey: true });
    const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect([global, page, off.global, off.page].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('leaves typing alone except Escape, arrows in widgets that use them, and open dialogs', () => {
    const { global, page } = setup();
    const input = document.body.appendChild(document.createElement('input'));
    expect(press('n', {}, input)).toBe(false);
    press('Escape', {}, input);
    expect(global).toHaveBeenLastCalledWith('closeArticle');

    const menu = document.body.appendChild(document.createElement('div'));
    menu.setAttribute('role', 'menu');
    expect(press('ArrowDown', {}, menu)).toBe(false);
    expect(press('ArrowDown')).toBe(true);
    page.mockClear();

    document.body.appendChild(document.createElement('div')).className =
      'v-overlay--active v-dialog';
    expect(press('n')).toBe(false);
    expect(page).not.toHaveBeenCalled();
  });

  it("drops the page's handler when it unmounts, and stops listening with the layout", async () => {
    const { wrapper, global, page, reader } = setup();
    reader.value = false;
    await nextTick();
    expect(press('n')).toBe(false);
    expect(page).not.toHaveBeenCalled();
    expect(global).toHaveBeenLastCalledWith('nextArticle');

    wrapper.unmount();
    press('/');
    expect(global).toHaveBeenCalledOnce();
  });
});
