import { computed, ref } from 'vue';

/** A request still pending after this long shows the app's progress bar; quicker ones never flash it. */
export const SHOW_AFTER_MS = 300;

const shownCount = ref(0);

/** True while any tracked request has been pending for longer than `SHOW_AFTER_MS`. */
export const loading = computed(() => shownCount.value > 0);

/** Wraps `fetch` so its pending requests show in `loading`. */
export function trackLoading(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const request = { shown: false };
    const timer = setTimeout(() => {
      request.shown = true;
      shownCount.value++;
    }, SHOW_AFTER_MS);
    try {
      return await fetch(input, init);
    } finally {
      clearTimeout(timer);
      if (request.shown) shownCount.value--;
    }
  };
}
