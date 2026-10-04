import {
  DEFAULT_PREFS,
  type PrefKey,
  type Prefs,
  prefsSchema,
  type UpdatePrefsRequest,
} from '@rss-reader/shared';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { userPrefs } from '../db/schema.ts';

/** A user's integer preference as a SQL scalar, null when unset; `userId` is a SQL expression. */
export const userPrefInt = (userId: SQL, key: PrefKey): SQL<number | null> =>
  sql`(SELECT (p.value #>> '{}')::int FROM user_prefs p WHERE p.user_id = ${userId} AND p.key = ${key})`;

const isPrefKey = (key: string): key is PrefKey => Object.hasOwn(DEFAULT_PREFS, key);

/** Per-user preferences stored as one row per changed key; unset keys take their defaults. */
export class PrefsService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(userId: number): Promise<Prefs> {
    const rows = await this.#db.select().from(userPrefs).where(eq(userPrefs.userId, userId));
    const prefs: Record<string, unknown> = { ...DEFAULT_PREFS };
    for (const row of rows) {
      // Values that no longer validate (e.g. after a schema change) fall back to the default.
      if (isPrefKey(row.key) && prefsSchema.shape[row.key].safeParse(row.value).success)
        prefs[row.key] = row.value;
    }
    return prefs as Prefs;
  }

  /** Applies the changes; null resets a nullable preference to its default. */
  async update(userId: number, changes: UpdatePrefsRequest): Promise<Prefs> {
    const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
    const reset = entries.filter(([, value]) => value === null).map(([key]) => key);
    const set = entries.filter(([, value]) => value !== null);
    await this.#db.transaction(async (tx) => {
      if (reset.length > 0)
        await tx
          .delete(userPrefs)
          .where(and(eq(userPrefs.userId, userId), inArray(userPrefs.key, reset)));
      if (set.length > 0)
        await tx
          .insert(userPrefs)
          .values(set.map(([key, value]) => ({ userId, key, value })))
          .onConflictDoUpdate({
            target: [userPrefs.userId, userPrefs.key],
            set: { value: sql`excluded.value` },
          });
    });
    return this.get(userId);
  }
}
