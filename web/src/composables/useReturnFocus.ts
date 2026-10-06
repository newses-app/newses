import { watch } from 'vue';

/**
 * Remembers what had focus when a dialog opens; the returned handler, bound to the dialog's
 * `after-leave`, focuses it again. Vuetify only does this for an activator slot, and these dialogs
 * open from the store, menus, and shortcuts.
 */
export function useReturnFocus(open: () => boolean): () => void {
  let previous: HTMLElement | null = null;
  watch(
    open,
    (value) => {
      if (value && document.activeElement instanceof HTMLElement) previous = document.activeElement;
    },
    { flush: 'sync' },
  );
  return () => {
    if (previous?.isConnected) previous.focus();
    previous = null;
  };
}
