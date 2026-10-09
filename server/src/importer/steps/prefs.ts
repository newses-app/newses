import { type PrefKey, prefsSchema } from '@rss-reader/shared';
import { sql } from 'drizzle-orm';
import { userPrefs } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { importedUsers } from './common.ts';

const bool = (value: string) => value === 'true' || value === '1';
const int = (value: string) => (/^-?\d+$/.test(value.trim()) ? Number(value) : Number.NaN);

/** TTRSS preferences with an equivalent here, and how their text values convert. */
const PREFS: Record<string, { key: PrefKey; value: (text: string) => unknown }> = {
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
};

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
      const rows = await source.query<SourcePrefRow>(
        `SELECT pref_name, value FROM ttrss_user_prefs2
         WHERE owner_uid = $1 AND profile IS NULL ORDER BY pref_name`,
        [user.id],
      );
      const known = rows.filter((r) => Object.hasOwn(PREFS, r.pref_name));
      const others = rows.filter((r) => !Object.hasOwn(PREFS, r.pref_name));
      report.count(user.login, 'preferences', { source: known.length });
      const values: { userId: number; key: PrefKey; value: unknown }[] = [];
      for (const row of known) {
        const pref = PREFS[row.pref_name];
        if (!pref) continue;
        const value = pref.value(row.value);
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
