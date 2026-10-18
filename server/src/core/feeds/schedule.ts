import { type SQL, sql } from 'drizzle-orm';

/** Publisher hints (Cache-Control, RSS ttl) lengthen the interval up to this. */
export const MAX_HINT_SECONDS = 24 * 60 * 60;
/** Each 429 doubles the slowdown, up to this. */
export const MAX_SLOWDOWN_SECONDS = 24 * 60 * 60;
/** Consecutive successful fetches after which the slowdown halves. */
export const EASE_AFTER_FETCHES = 5;
/** Intervals are stretched by up to this fraction so feeds added together drift apart. */
const JITTER = 0.1;

/** What sets a feed source's interval, longest first wins (ties go to the earlier one). */
export type IntervalReason = 'subscribers' | 'publisher' | 'slowdown' | 'siteMinimum';

export interface ScheduleInputs {
  /** Shortest interval among the source's unpaused subscriptions; null when all are paused. */
  base: number | null;
  /** Publisher hint of the last successful fetch. */
  hint: number | null;
  /** Raised by HTTP 429. */
  slowdown: number | null;
  /** Admins' minimum for the source's host. */
  siteMinimum: number | null;
}

export interface Schedule {
  seconds: number;
  /** `unscheduled` when every subscription is paused: dispatch skips the source. */
  reason: IntervalReason | 'unscheduled';
}

/**
 * The interval in effect: the longest of the subscribers' base (`fallback` when all are paused),
 * the publisher hint (capped at a day), the slowdown, and the site minimum.
 */
export function effectiveInterval(inputs: ScheduleInputs, fallback: number): Schedule {
  const candidates: [IntervalReason, number | null][] = [
    ['subscribers', inputs.base ?? fallback],
    ['publisher', inputs.hint === null ? null : Math.min(MAX_HINT_SECONDS, inputs.hint)],
    ['slowdown', inputs.slowdown],
    ['siteMinimum', inputs.siteMinimum],
  ];
  let best: Schedule = { seconds: 0, reason: 'subscribers' };
  for (const [reason, seconds] of candidates) {
    if (seconds !== null && seconds > best.seconds) best = { seconds, reason };
  }
  return inputs.base === null ? { ...best, reason: 'unscheduled' } : best;
}

/** `seconds` stretched by up to 10 % random jitter. */
export const jittered = (seconds: number, random = Math.random()) =>
  Math.round(seconds * (1 + JITTER * random));

/** The slowdown after a 429: twice the longer of the current slowdown and the interval without it. */
export const afterThrottle = (slowdown: number | null, withoutSlowdown: number) =>
  Math.min(MAX_SLOWDOWN_SECONDS, 2 * Math.max(slowdown ?? 0, withoutSlowdown));

/**
 * The slowdown after a successful fetch: halved after a run of them, and cleared once it would no
 * longer lengthen the interval.
 */
export function afterSuccess(
  slowdown: number | null,
  okCount: number,
  withoutSlowdown: number,
): { slowdown: number | null; okCount: number } {
  if (slowdown === null) return { slowdown: null, okCount: 0 };
  if (okCount + 1 < EASE_AFTER_FETCHES) return { slowdown, okCount: okCount + 1 };
  const half = Math.round(slowdown / 2);
  return { slowdown: half <= withoutSlowdown ? null : half, okCount: 0 };
}

/** The host (and port) of a normalised feed URL in SQL, as `new URL(url).host` gives it. */
export const sourceHost = (url: SQL) =>
  sql<string>`lower(substring(${url} FROM '^[^:]+://(?:[^/?#@]*@)?([^/?#]+)'))`;
