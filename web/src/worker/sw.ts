/// <reference lib="webworker" />
// The browser's service worker: the app shell offline, theme fonts and feed icons once used,
// syncing with no tab open where the browser allows it (installed Chrome and Edge apps), and
// notifications of new entries the server pushes. What each route and event does is in
// ../offline/worker-events.ts.
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import {
  isFeedIcon,
  isFont,
  NOT_APP_SHELL,
  onNotificationClick,
  onPeriodicSync,
  onPush,
  onSync,
  type SyncEvent,
} from '../offline/worker-events.ts';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

// A new version takes over at once (`registerType: 'autoUpdate'`).
void self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: NOT_APP_SHELL }),
);

// API responses are never cached; theme fonts and feed icons are, so they show offline.
registerRoute(
  isFont,
  new CacheFirst({ cacheName: 'fonts', plugins: [new ExpirationPlugin({ maxEntries: 20 })] }),
);
registerRoute(
  isFeedIcon,
  new CacheFirst({ cacheName: 'favicons', plugins: [new ExpirationPlugin({ maxEntries: 500 })] }),
);

self.addEventListener('periodicsync', (event) => {
  onPeriodicSync(event as ExtendableEvent & SyncEvent);
});
self.addEventListener('sync', (event) => {
  onSync(event as ExtendableEvent & SyncEvent);
});
self.addEventListener('push', (event) => {
  onPush(event, self.registration, self.clients);
});
self.addEventListener('notificationclick', (event) => {
  onNotificationClick(event, self.clients);
});
