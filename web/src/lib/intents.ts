import {
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  MAX_PAGE_URL_LENGTH,
} from '@newses/shared/client';
import type { LocationQuery } from 'vue-router';
import { type SharedLink, sharedLink } from '../platform/share.ts';
import type { PublishDraft } from '../stores/ui.ts';

// Addresses that open the app's Publish or Subscribe dialog filled in (bookmarklets, an installed
// web app's share target). They only fill the dialog in: a link must not act on its own.

/** Selected text a bookmarklet sends at most, keeping its address within proxies' limits. */
export const MAX_BOOKMARKLET_TEXT = 2000;

function param(query: LocationQuery, name: string): string | null {
  const value = query[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || null;
}

/** `/publish?url=&title=&text=` */
export function publishDraftFrom(query: LocationQuery): PublishDraft | null {
  const url = param(query, 'url');
  if (!url) return null;
  return {
    url: url.slice(0, MAX_PAGE_URL_LENGTH),
    title: param(query, 'title')?.slice(0, MAX_PAGE_TITLE_LENGTH) ?? null,
    text: param(query, 'text')?.slice(0, MAX_PAGE_TEXT_LENGTH) ?? null,
  };
}

/** `/subscribe?url=` */
export function subscribeUrlFrom(query: LocationQuery): string | null {
  return param(query, 'url')?.slice(0, MAX_PAGE_URL_LENGTH) ?? null;
}

/** `/share?title=&text=&url=`, as a web app share target receives it; the address is often in `text`. */
export function sharedLinkFrom(query: LocationQuery): SharedLink | null {
  const text = [param(query, 'text'), param(query, 'url')].filter(Boolean).join(' ');
  return sharedLink(text, param(query, 'title'));
}

/** Bookmarklets that open the page they are used on in the app at `origin`, in a small window. */
export function bookmarklets(origin: string): { publish: string; subscribe: string } {
  const open = (path: string, query: string) =>
    `javascript:(()=>{${query}open(${JSON.stringify(`${origin}${path}`)}+q,'newses','popup,width=600,height=720')})()`;
  return {
    publish: open(
      '/publish',
      `const s=String(getSelection()).slice(0,${String(MAX_BOOKMARKLET_TEXT)});const q='?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+(s?'&text='+encodeURIComponent(s):'');`,
    ),
    subscribe: open('/subscribe', `const q='?url='+encodeURIComponent(location.href);`),
  };
}
