import { ref } from 'vue';
import type { PlatformBridge } from './bridge.ts';

/** The first http(s) URL in shared text (a page title often comes first), without trailing punctuation. */
export function firstUrl(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const candidate = match[0].replace(/[).,;:!?\]]+$/, '');
    try {
      return new URL(candidate).href;
    } catch {
      // Not a URL after all; try the next.
    }
  }
  return null;
}

/**
 * URLs shared to the app wait here until someone is signed in, then open the subscribe dialog.
 */
export function createShares(bridge: PlatformBridge) {
  const pending = ref<string | null>(null);
  bridge.onShare((text) => {
    const url = firstUrl(text);
    if (url) pending.value = url;
  });
  return {
    pending,
    /** The waiting URL, once. */
    take() {
      const url = pending.value;
      pending.value = null;
      return url;
    },
  };
}
