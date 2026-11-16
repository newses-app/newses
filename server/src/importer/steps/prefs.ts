import { isTimeZone, type PrefKey, prefsSchema, wallClock } from '@newses/shared';
import { matchLocale } from '@newses/shared/locales';
import { sql } from 'drizzle-orm';
import { userPrefs } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { importedUsers } from './common.ts';

const bool = (value: string) => value === 'true' || value === '1';
const int = (value: string) => (/^-?\d+$/.test(value.trim()) ? Number(value) : Number.NaN);

/** TTRSS writes locales such as `es_ES`; a language not on offer has no equivalent. */
const language = (text: string) => matchLocale([text.trim().replace('_', '-')]);

/** The user's TTRSS preferences by name. */
type SourcePrefs = ReadonlyMap<string, string>;

/** The time zone TTRSS's user chose, if this runtime knows it; TTRSS itself runs in UTC. */
const sourceZone = (prefs: SourcePrefs) => {
  const zone = prefs.get('USER_TIMEZONE')?.trim() ?? '';
  return zone && zone !== 'Automatic' && isTimeZone(zone) ? zone : 'UTC';
};

/** `HH:MM` as hours and minutes; null when it is not a time of day. */
const timeOfDay = (text: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  const [hour, minute] = [Number(match?.[1]), Number(match?.[2])];
  return match && hour < 24 && minute < 60 ? { hour, minute } : null;
};

/**
 * TTRSS sends digests from a time in UTC; here they come at an hour in the user's time zone, the
 * one that time falls in today.
 */
const digestHour = (text: string, prefs: SourcePrefs) => {
  const time = timeOfDay(text);
  if (!time) return Number.NaN;
  const now = new Date();
  const at = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    time.hour,
    time.minute,
  );
  return wallClock(at, sourceZone(prefs)).hour;
};

/**
 * TTRSS preferences with an equivalent here, and how their text values convert, given the user's
 * other preferences; `unset` lists the values that mean the user never chose one, and `note`
 * explains a value that changed in the conversion.
 */
const PREFS: Record<
  string,
  {
    key: PrefKey;
    value: (text: string, prefs: SourcePrefs) => unknown;
    unset?: readonly string[];
    note?: (text: string, prefs: SourcePrefs, value: unknown) => string | null;
  }
> = {
  FRESH_ARTICLE_MAX_AGE: { key: 'freshMaxAgeHours', value: int },
  PURGE_OLD_DAYS: { key: 'purgeDays', value: int },
  DEFAULT_UPDATE_INTERVAL: { key: 'updateIntervalMinutes', value: int },
  COMBINED_DISPLAY_MODE: {
    key: 'layout',
    value: (text) => (bool(text) ? 'combined' : 'threePane'),
  },
  CDM_AUTO_CATCHUP: { key: 'markReadOnScroll', value: bool },
  CONFIRM_FEED_CATCHUP: { key: 'confirmCatchUp', value: bool },
  HIDE_READ_FEEDS: { key: 'hideReadFeeds', value: bool },
  _DEFAULT_VIEW_MODE: {
    key: 'viewMode',
    value: (text) => ({ all_articles: 'all', unread: 'unread', adaptive: 'adaptive' })[text],
  },
  _DEFAULT_VIEW_ORDER_BY: {
    key: 'sortOrder',
    value: (text) =>
      ({ default: 'newest', feed_dates: 'newest', date_reverse: 'oldest', title: 'title' })[text],
  },
  USER_LANGUAGE: { key: 'language', value: language, unset: ['', 'auto'] },
  USER_TIMEZONE: { key: 'timeZone', value: (text) => text.trim(), unset: ['', 'Automatic'] },
  DIGEST_ENABLE: { key: 'digestFrequency', value: (text) => (bool(text) ? 'daily' : 'off') },
  DIGEST_PREFERRED_TIME: {
    key: 'digestHour',
    value: digestHour,
    note: (text, prefs, value) => {
      const zone = sourceZone(prefs);
      return zone === 'UTC' && timeOfDay(text)?.minute === 0
        ? null
        : `digest time ${text.trim()} UTC imported as ${String(value).padStart(2, '0')}:00 ${zone}`;
    },
  },
  DIGEST_CATCHUP: { key: 'digestMarkRead', value: bool },
};

/** TTRSS's time for digests when its user never changed it. */
const DEFAULT_DIGEST_TIME = '00:00';

/**
 * The preferences that decide what the user's TTRSS did: digests turned on in the user's row
 * (older TTRSS) when no preference says otherwise, and the default time of digests that are on.
 */
function effectivePrefs(rows: SourcePrefRow[], emailDigest: boolean): SourcePrefRow[] {
  const names = new Set(rows.map((r) => r.pref_name));
  const effective = [...rows];
  if (!names.has('DIGEST_ENABLE') && emailDigest)
    effective.push({ pref_name: 'DIGEST_ENABLE', value: 'true' });
  const enabled = effective.find((r) => r.pref_name === 'DIGEST_ENABLE');
  if (enabled && bool(enabled.value) && !names.has('DIGEST_PREFERRED_TIME'))
    effective.push({ pref_name: 'DIGEST_PREFERRED_TIME', value: DEFAULT_DIGEST_TIME });
  return effective;
}

interface SourcePrefRow {
  pref_name: string;
  value: string;
}

/** Preferences with an equivalent here (the default profile's); others are listed in a note. */
export const prefsStep: ImportStep = {
  name: 'preferences',
  async run(context) {
    const { source, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const [owner] = await source.query<{ email_digest: boolean }>(
        'SELECT email_digest FROM ttrss_users WHERE id = $1',
        [user.id],
      );
      const rows = effectivePrefs(
        await source.query<SourcePrefRow>(
          `SELECT pref_name, value FROM ttrss_user_prefs2
           WHERE owner_uid = $1 AND profile IS NULL ORDER BY pref_name`,
          [user.id],
        ),
        owner?.email_digest ?? false,
      );
      const byName: SourcePrefs = new Map(rows.map((r) => [r.pref_name, r.value]));
      const known = rows.filter((r) => Object.hasOwn(PREFS, r.pref_name));
      const others = rows.filter((r) => !Object.hasOwn(PREFS, r.pref_name));
      report.count(user.login, 'preferences', { source: known.length });
      const values: { userId: number; key: PrefKey; value: unknown }[] = [];
      for (const row of known) {
        const pref = PREFS[row.pref_name];
        if (!pref || pref.unset?.includes(row.value.trim())) continue;
        const value = pref.value(row.value, byName);
        if (!prefsSchema.shape[pref.key].safeParse(value).success) {
          report.skip(
            user.login,
            'preferences',
            0,
            `${row.pref_name} = "${row.value}" has no equivalent value`,
          );
          continue;
        }
        values.push({ userId, key: pref.key, value });
        const note = pref.note?.(row.value, byName, value);
        if (note) report.note(user.login, 'preferences', 0, note);
      }
      if (values.length > 0)
        await write((tx) =>
          tx
            .insert(userPrefs)
            .values(values)
            .onConflictDoUpdate({
              target: [userPrefs.userId, userPrefs.key],
              set: { value: sql`excluded.value` },
            }),
        );
      report.count(user.login, 'preferences', { imported: values.length });
      if (others.length > 0)
        report.note(
          user.login,
          'preferences',
          0,
          `not imported: ${others.map((r) => r.pref_name).join(', ')}`,
        );
    }
  },
};
