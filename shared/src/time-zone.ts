// Wall-clock time in IANA time zones, from Intl alone. No Zod, so browsers can import it.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** This device's IANA time zone. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Whether `timeZone` is an IANA time zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar fields of `instant` in `timeZone`. */
export function wallClock(instant: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function offset(instant: number, timeZone: string): number {
  const f = wallClock(instant, timeZone);
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time (given as that time in UTC) happens in `timeZone`. A time that a
 * clock change skips comes out as the time after the change; one that happens twice, the later.
 */
export function zonedInstant(wall: number, timeZone: string): number {
  const guess = wall - offset(wall, timeZone);
  return wall - offset(guess, timeZone);
}

/** The instant a calendar day (as UTC midnight of that date) begins in `timeZone`. */
export const startOfDay = (utcMidnight: number, timeZone: string): number =>
  zonedInstant(utcMidnight, timeZone);

/**
 * The first `hour`:00 in `timeZone` after `now`, on `weekday` (0 Sunday to 6 Saturday) when
 * given, else on any day.
 */
export function nextOccurrence(
  now: Date,
  timeZone: string,
  hour: number,
  weekday: number | null = null,
): Date {
  const today = wallClock(now.getTime(), timeZone);
  const midnight = Date.UTC(today.year, today.month - 1, today.day);
  for (let days = 0; days <= 8; days++) {
    const day = midnight + days * DAY_MS;
    if (weekday !== null && new Date(day).getUTCDay() !== weekday) continue;
    const at = zonedInstant(day + hour * HOUR_MS, timeZone);
    if (at > now.getTime()) return new Date(at);
  }
  // Unreachable: a week always has the day and hour.
  throw new Error('No next occurrence');
}
