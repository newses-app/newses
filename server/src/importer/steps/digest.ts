import { inArray, sql } from 'drizzle-orm';
import { userPrefs } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { importedUsers } from './common.ts';

/**
 * Digests: a user who has them on starts after the entries imported, which are not new to them;
 * the next run of the digest task sets when the first is due.
 */
export const digestStep: ImportStep = {
  name: 'digest',
  async run(context) {
    const ids = (await importedUsers(context)).map((u) => u.userId);
    if (ids.length === 0) return;
    await context.write((tx) =>
      tx.execute(sql`
        INSERT INTO digest_state (user_id, watermark, next_due_at)
        SELECT user_prefs.user_id,
          (SELECT coalesce(max(ue.id), 0) FROM user_entries ue WHERE ue.user_id = user_prefs.user_id),
          now()
        FROM user_prefs
        WHERE ${inArray(userPrefs.userId, ids)}
          AND key = 'digestFrequency' AND value #>> '{}' IN ('daily', 'weekly')
        ON CONFLICT (user_id) DO UPDATE
          SET watermark = greatest(digest_state.watermark, excluded.watermark)`),
    );
  },
};
