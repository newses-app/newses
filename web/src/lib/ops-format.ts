// Operations figures as the operations page shows them (components/settings/OperationsPanel.vue).

export const formatCount = (value: number, locale: string) =>
  new Intl.NumberFormat(locale).format(value);

/** `part` of `whole` as a whole percentage; a dash when there is nothing to divide. */
export const formatShare = (part: number, whole: number, locale: string) =>
  whole === 0
    ? '–'
    : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
        part / whole,
      );

/** Bytes in kilobytes, or megabytes from a million. */
export const formatBytes = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    notation: 'compact',
    style: 'unit',
    unit: value >= 1e6 ? 'megabyte' : 'kilobyte',
    maximumFractionDigits: 1,
  }).format(value >= 1e6 ? value / 1e6 : value / 1e3);

/** Milliseconds, or seconds to one decimal from a second. */
export const formatMs = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: value >= 1000 ? 'second' : 'millisecond',
    minimumFractionDigits: value >= 1000 ? 1 : 0,
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value >= 1000 ? value / 1000 : value);

/** The ops check runs every few minutes (every 30 on AWS); an hour without one means it stopped. */
export const CHECK_STALE_MS = 60 * 60 * 1000;

/** Whether the alert rules have stopped being checked; false until the summary arrives. */
export function checksStale(
  summary: { checkedAt: string | null } | undefined,
  now = Date.now(),
): boolean {
  if (summary === undefined) return false;
  return !summary.checkedAt || now - Date.parse(summary.checkedAt) > CHECK_STALE_MS;
}

/** Alerts still open, and those resolved, in the order given. */
export function splitAlerts<T extends { resolvedAt: string | null }>(alerts: readonly T[] = []) {
  return {
    open: alerts.filter((alert) => !alert.resolvedAt),
    resolved: alerts.filter((alert) => alert.resolvedAt),
  };
}
