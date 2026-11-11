import type { NotificationStrings, PushSubscriptionRequest } from '@newses/shared';
import { api } from '../api.ts';
import { NEW_ENTRIES_TAG, readPushConfig, writePushConfig } from './worker-config.ts';

/**
 * Whether this browser can get the server's push messages: `needsInstall` on iPhone and iPad,
 * whose Safari has Web Push only in apps added to the Home Screen.
 */
export type WebPushSupport = 'supported' | 'needsInstall' | 'unsupported';

/** The browser's notifications of new entries for the signed-in user. */
export type WebPushState = 'on' | 'off' | 'denied';

export function webPushSupport(): WebPushSupport {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)
    return 'supported';
  const ua = navigator.userAgent;
  const apple =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return apple ? 'needsInstall' : 'unsupported';
}

const keyBytes = (key: string) =>
  Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const bytes = new Uint8Array(a);
  return bytes.every((byte, i) => byte === b[i]);
}

/** This browser's subscription for `key`: the one it has, or a new one when the key changed. */
async function subscription(key: string): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;
  const bytes = keyBytes(key);
  const existing = await registration.pushManager.getSubscription();
  if (existing && sameKey(existing.options.applicationServerKey, bytes)) return existing;
  await existing?.unsubscribe();
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
}

function request(subscription: PushSubscription): PushSubscriptionRequest {
  const { endpoint, keys } = subscription.toJSON();
  return { endpoint: endpoint ?? '', keys: { p256dh: keys?.p256dh ?? '', auth: keys?.auth ?? '' } };
}

async function current(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function webPushState(userId: number): Promise<WebPushState> {
  if (Notification.permission === 'denied') return 'denied';
  const [config, subscribed] = await Promise.all([readPushConfig(), current()]);
  return Notification.permission === 'granted' && subscribed && config?.userId === userId
    ? 'on'
    : 'off';
}

/**
 * Asks for the permission, subscribes this browser with the server's key, and binds it to the
 * session. Throws when the browser or the server refuses the subscription.
 */
export async function enableWebPush(
  userId: number,
  key: string,
  strings: NotificationStrings,
): Promise<WebPushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  await api.push.subscribe(request(await subscription(key)));
  await writePushConfig({ userId, strings });
  return 'on';
}

export async function disableWebPush(): Promise<void> {
  await writePushConfig(null);
  await api.push.unsubscribe().catch(() => undefined);
  await (await current())?.unsubscribe();
}

/**
 * At launch: binds this browser's subscription to the session again (a new one after signing in,
 * or the server's new key) with the wording in the app's language. One another user turned on,
 * or that the server no longer takes (`key` null), goes.
 */
export async function renewWebPush(
  userId: number,
  key: string | null,
  strings: NotificationStrings,
): Promise<void> {
  const [config, subscribed] = await Promise.all([readPushConfig(), current()]);
  if (!subscribed) {
    if (config) await writePushConfig(null);
    return;
  }
  if (config?.userId !== userId || !key || Notification.permission !== 'granted') {
    await writePushConfig(null);
    await subscribed.unsubscribe();
    return;
  }
  await api.push.subscribe(request(await subscription(key)));
  await writePushConfig({ userId, strings });
}

/** The wording follows the app's language, while notifications are on. */
export async function rewordWebPush(strings: NotificationStrings): Promise<void> {
  const config = await readPushConfig();
  if (config) await writePushConfig({ ...config, strings });
}

/**
 * Signing out here stops this browser's messages, so whoever signs in next does not get them (the
 * server's subscription ended with the session).
 */
export async function webPushSignedOut(): Promise<void> {
  await writePushConfig(null);
  await (await current())?.unsubscribe();
}

/** The reader is back: the notification goes, and the next one counts from now. */
export async function closeNewEntriesNotification(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  for (const notification of (await registration?.getNotifications({ tag: NEW_ENTRIES_TAG })) ?? [])
    notification.close();
}
