import type { Subscription } from '@newses/shared';

/** The feed dialog's line on how often the feed is checked, as a message key and its interval. */
export function scheduleMessage(
  subscription: Partial<Pick<Subscription, 'intervalReason' | 'effectiveIntervalMinutes'>>,
): { key: string; minutes: number | null } | null {
  const { intervalReason: reason, effectiveIntervalMinutes: minutes = null } = subscription;
  // Servers before API 1.4 leave these out; feeds not checked yet have none.
  if (!reason) return null;
  if (reason === 'paused') return { key: 'feeds.schedule.paused', minutes: null };
  if (minutes === null) return null;
  return { key: `feeds.schedule.${reason}`, minutes };
}
