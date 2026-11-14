// The desktop notification of new entries: one at a time, each the running total so far.
import { Notification } from 'electron';

/**
 * The notification shown last, kept until the next replaces it: one that is garbage collected
 * loses its click, and on Windows it stays in Action Center after its banner closes.
 */
let shown: Notification | null = null;

/** Takes the last notification off the screen and out of the notification centre. */
export function closeShown(): void {
  shown?.close();
  shown = null;
}

/** Shows a notification in place of the last one, where the system has notifications. */
export function showNotification(title: string, body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', onClick);
  closeShown();
  shown = notification;
  notification.show();
}
