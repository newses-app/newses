import { inject, type InjectionKey, onBeforeUnmount, onMounted, provide, shallowRef } from 'vue';
import { isTyping, type ShortcutAction, ShortcutMatcher, usesArrowKeys } from '../lib/shortcuts.ts';
import { usePrefs } from './usePrefs.ts';

type Handler = (action: ShortcutAction) => boolean;
const HANDLERS: InjectionKey<{ value: Handler | null }> = Symbol('shortcut-handlers');

/**
 * Listens for shortcut keys in the signed-in layout. `global` handles actions that work on every
 * page; the reader registers its own handler for the rest with `useShortcutHandler`.
 */
export function useShortcutListener(global: Handler): void {
  const page = shallowRef<Handler | null>(null);
  provide(HANDLERS, page);
  const matcher = new ShortcutMatcher();
  const { prefs } = usePrefs();

  const onKeyDown = (event: KeyboardEvent) => {
    if (!prefs.value.keyboardShortcuts) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    if (isTyping(event.target) && event.key !== 'Escape') return;
    if (event.key.startsWith('Arrow') && usesArrowKeys(event.target)) return;
    if (document.querySelector('.v-overlay--active:is(.v-dialog, .v-menu)')) return;
    const action = matcher.press(event.key);
    if (!action) return;
    if (page.value?.(action) || global(action)) event.preventDefault();
  };

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown);
  });
}

/** Registers the current page's shortcut handler; it returns true when it handled the action. */
export function useShortcutHandler(handler: Handler): void {
  const page = inject(HANDLERS, null);
  onMounted(() => {
    if (page) page.value = handler;
  });
  onBeforeUnmount(() => {
    if (page?.value === handler) page.value = null;
  });
}
