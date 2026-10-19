import { MAX_PAGE_TITLE_LENGTH } from '@newses/shared/client';
import { ref } from 'vue';
import type { PlatformBridge } from './bridge.ts';

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** The first http(s) URL in shared text (a page title often comes first), without trailing punctuation. */
export function firstUrl(text: string): string | null {
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(/[).,;:!?\]]+$/, '');
    try {
      return new URL(candidate).href;
    } catch {
      // Not a URL after all; try the next.
    }
  }
  return null;
}

/** A page shared to the app. */
export interface SharedLink {
  url: string;
  title: string | null;
}

/**
 * The page in shared text: its first web address, titled by the subject or else by the rest of
 * the text (browsers send "Title https://…" or the title as the subject); null without an address.
 */
export function sharedLink(text: string, subject: string | null = null): SharedLink | null {
  const url = firstUrl(text) ?? (subject ? firstUrl(subject) : null);
  if (!url) return null;
  const words = (subject && !firstUrl(subject) ? subject : text.replace(URL_PATTERN, ' '))
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|:·]+|[\s\-–—|:·]+$/g, '')
    .slice(0, MAX_PAGE_TITLE_LENGTH);
  return { url, title: words || null };
}

const CARRIED_KEY = 'newses.share';

/** A page carried across the reload onto another profile, once. */
function carried(): SharedLink | null {
  try {
    const value = sessionStorage.getItem(CARRIED_KEY);
    sessionStorage.removeItem(CARRIED_KEY);
    const link = value ? (JSON.parse(value) as Partial<SharedLink>) : null;
    if (typeof link?.url !== 'string' || firstUrl(link.url) !== link.url) return null;
    return { url: link.url, title: typeof link.title === 'string' ? link.title : null };
  } catch {
    return null;
  }
}

/**
 * Pages shared to the app wait here until someone is signed in, then are offered to subscribe to
 * or publish.
 */
export function createShares(bridge: PlatformBridge) {
  const pending = ref<SharedLink | null>(carried());
  bridge.onShare((text, subject) => {
    const link = sharedLink(text, subject);
    if (link) pending.value = link;
  });
  return {
    pending,
    /** Offers a page shared some other way (an installed web app's share target). */
    offer(link: SharedLink) {
      pending.value = link;
    },
    /** Keeps a page for the app to offer again after it reloads on another profile. */
    carry(link: SharedLink) {
      try {
        sessionStorage.setItem(CARRIED_KEY, JSON.stringify(link));
      } catch {
        // Storage blocked: the page is not offered there.
      }
    },
    /** The waiting page, once. */
    take() {
      const link = pending.value;
      pending.value = null;
      return link;
    },
  };
}
