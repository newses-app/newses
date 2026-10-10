import { computed, ref } from 'vue';

/** A request still pending after this long is probably waiting for the server to wake up. */
export const SLOW_MS = 3000;

const slowCount = ref(0);

/** True while any tracked request has been pending for longer than `SLOW_MS`. */
export const slow = computed(() => slowCount.value > 0);

/** Wraps `fetch` so its slow requests show in `slow`. */
export function trackSlow(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const request = { slow: false };
    const timer = setTimeout(() => {
      request.slow = true;
      slowCount.value++;
    }, SLOW_MS);
    try {
      return await fetch(input, init);
    } finally {
      clearTimeout(timer);
      if (request.slow) slowCount.value--;
    }
  };
}
