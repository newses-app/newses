// The service worker's routes and events (src/worker/sw.ts installs them), apart from its globals
// so the page's tsconfig and the tests cover them.
import { runInBackground } from './background.ts';
import { openPushTarget, showPushMessage, type WorkerClients } from './push-worker.ts';
import { OUTBOX_TAG, SYNC_TAG } from './worker-config.ts';

/**
 * Paths the server answers itself (`NOT_SPA` in server/src/api/web.ts), which never get the app
 * shell: public pages and feeds, the native and compatibility APIs, and feed icons. Nor do the app
 * downloads, which CloudFront serves on AWS and the server on Docker.
 */
export const NOT_APP_SHELL = [
  /^\/(api|public|healthz|accounts|reader|feed-icons|favicons|downloads)(\/|$)/,
  /^\/public\.php$/,
];

/** Theme fonts, cached when first used (or loaded for offline reading). */
export const isFont = ({ request }: { request: Pick<Request, 'destination'> }) =>
  request.destination === 'font';

/** Feed icons, named by their content, so a cached one is never stale. */
export const isFeedIcon = ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
  sameOrigin && url.pathname.startsWith('/favicons/');

interface WaitingEvent {
  waitUntil(work: Promise<unknown>): void;
}

/** A Periodic Background Sync or Background Sync event, not in the TypeScript library yet. */
export interface SyncEvent extends WaitingEvent {
  readonly tag: string;
}

/** Periodic Background Sync: follows the server's changes with no tab open. */
export function onPeriodicSync(event: SyncEvent): void {
  if (event.tag === SYNC_TAG) event.waitUntil(runInBackground('sync').catch(() => undefined));
}

/** Background Sync: sends the changes kept offline once the connection returns. */
export function onSync(event: SyncEvent): void {
  // Rejecting has the browser try again later, with its own back-off.
  if (event.tag === OUTBOX_TAG) event.waitUntil(runInBackground('outbox'));
}

/**
 * A push from the server: shows the notification, then with offline reading on fetches the new
 * entries too, ready when the reader opens them.
 */
export function onPush(
  event: WaitingEvent & { readonly data: { json(): unknown } | null },
  registration: Parameters<typeof showPushMessage>[0],
  clients: WorkerClients,
): void {
  let data: unknown = null;
  try {
    data = event.data?.json();
  } catch {
    // Not JSON, so not a message to show; the sync still runs.
  }
  event.waitUntil(
    showPushMessage(registration, clients, data).then(() =>
      runInBackground('sync').catch(() => undefined),
    ),
  );
}

export function onNotificationClick(
  event: WaitingEvent & { readonly notification: Parameters<typeof openPushTarget>[0] },
  clients: WorkerClients,
): void {
  event.waitUntil(openPushTarget(event.notification, clients));
}
