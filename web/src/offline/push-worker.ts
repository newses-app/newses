import type { PushMessage } from '@newses/shared';
import { asPushMessage, mergePushMessages, pushNotificationText } from '../lib/new-entries.ts';
import { NAVIGATE_MESSAGE, NEW_ENTRIES_TAG, readPushConfig } from './worker-config.ts';

// The parts of the service worker's APIs used here, so the page's tsconfig checks this file too.
interface ShownNotification {
  data: unknown;
  close(): void;
}
interface WorkerRegistration {
  getNotifications(filter: { tag: string }): Promise<ShownNotification[]>;
  showNotification(
    title: string,
    options: NotificationOptions & { renotify?: boolean },
  ): Promise<void>;
}
interface WorkerWindow {
  readonly visibilityState: DocumentVisibilityState;
  readonly focused: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
export interface WorkerClients {
  matchAll(options: {
    type: 'window';
    includeUncontrolled?: boolean;
  }): Promise<readonly WorkerWindow[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * Shows a push message (browsers require one for each): the running total with the notification
 * still showing, worded in the app's language, and silent while the app is on screen.
 */
export async function showPushMessage(
  registration: WorkerRegistration,
  clients: WorkerClients,
  data: unknown,
): Promise<void> {
  const message = asPushMessage(data);
  if (!message) return;
  const [shown] = await registration.getNotifications({ tag: NEW_ENTRIES_TAG });
  const previous = shown ? asPushMessage(shown.data) : null;
  const total = previous ? mergePushMessages(previous, message) : message;
  const windows = await clients.matchAll({ type: 'window' });
  const config = await readPushConfig().catch(() => undefined);
  // Without the app's wording (turned off as this arrived), the numbers and places alone.
  const text = config
    ? pushNotificationText(config.strings, total)
    : { title: String(total.count), body: total.places.map((p) => p.title).join(', ') };
  await registration.showNotification(text.title, {
    body: text.body,
    tag: NEW_ENTRIES_TAG,
    renotify: true,
    silent: windows.some((w) => w.visibilityState === 'visible'),
    icon: '/icon-192.png',
    ...(config && { lang: config.strings.locale }),
    data: total satisfies PushMessage,
  });
}

/** Opens a clicked notification's stream in the app's window, or a new one. */
export async function openPushTarget(
  notification: ShownNotification,
  clients: WorkerClients,
): Promise<void> {
  notification.close();
  const target = asPushMessage(notification.data)?.target ?? '/all';
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const window = windows.find((w) => w.focused) ?? windows[0];
  if (!window) {
    await clients.openWindow(target);
    return;
  }
  await window.focus();
  window.postMessage({ type: NAVIGATE_MESSAGE, target });
}
