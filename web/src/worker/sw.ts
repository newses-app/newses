/// <reference lib="webworker" />
// The browser's service worker: the app shell offline, theme fonts and feed icons once used, and
// syncing with no tab open where the browser allows it (installed Chrome and Edge apps).
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { runInBackground } from '../offline/background.ts';
import { OUTBOX_TAG, SYNC_TAG } from '../offline/worker-config.ts';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

/** A Periodic Background Sync or Background Sync event, not in the TypeScript library yet. */
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

// A new version takes over at once (`registerType: 'autoUpdate'`).
void self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Paths the server answers itself (`NOT_SPA` in server/src/api/web.ts): public pages and feeds,
// the native and compatibility APIs, and feed icons never get the app shell. Nor do the app
// downloads, which CloudFront serves on AWS.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [
      /^\/(api|public|healthz|accounts|reader|feed-icons|favicons|downloads)(\/|$)/,
      /^\/public\.php$/,
    ],
  }),
);

// API responses are never cached. Theme fonts are, when first used (or loaded for offline
// reading), so only the fonts in use download.
registerRoute(
  ({ request }) => request.destination === 'font',
  new CacheFirst({ cacheName: 'fonts', plugins: [new ExpirationPlugin({ maxEntries: 20 })] }),
);

// Feed icons are named by their content, so a cached one is never stale; kept, they show offline.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/favicons/'),
  new CacheFirst({ cacheName: 'favicons', plugins: [new ExpirationPlugin({ maxEntries: 500 })] }),
);

self.addEventListener('periodicsync', (event) => {
  const sync = event as SyncEvent;
  if (sync.tag === SYNC_TAG) sync.waitUntil(runInBackground('sync').catch(() => undefined));
});

self.addEventListener('sync', (event) => {
  const sync = event as SyncEvent;
  // Rejecting has the browser try again later, with its own back-off.
  if (sync.tag === OUTBOX_TAG) sync.waitUntil(runInBackground('outbox'));
});
