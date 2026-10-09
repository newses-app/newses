import { MAX_TAGS_PER_ENTRY, normaliseTag } from '@rss-reader/shared';
import { sql } from 'drizzle-orm';
import { entryTags } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { importedUsers } from './common.ts';
import { USER_ENTRIES } from './entries.ts';

/** Tags written per statement. */
const CHUNK = 5000;

interface SourceTagRow {
  tag_name: string;
  post_int_id: number;
}

/**
 * Tags, normalised as tags are here (`normaliseTag`): lower-case, single-spaced, without commas,
 * at most 64 characters and 50 per entry. Re-runs replace the imported entries' tags.
 */
export const tagsStep: ImportStep = {
  name: 'tags',
  async run(context) {
    const { source, map, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const { login } = user;
      const rows = await source.query<SourceTagRow>(
        'SELECT tag_name, post_int_id FROM ttrss_tags WHERE owner_uid = $1 ORDER BY post_int_id, id',
        [user.id],
      );
      report.count(login, 'tags', { source: rows.length });
      const entryIds = await map.targets(USER_ENTRIES, [
        ...new Set(rows.map((r) => r.post_int_id)),
      ]);
      const byEntry = new Map<number, Set<string>>();
      const skipped = { unmapped: 0, empty: 0, duplicate: 0, overLimit: 0 };
      let changed = 0;
      for (const row of rows) {
        const userEntryId = entryIds.get(row.post_int_id);
        if (userEntryId === undefined) {
          skipped.unmapped++;
          continue;
        }
        const tag = normaliseTag(row.tag_name);
        if (!tag) {
          skipped.empty++;
          continue;
        }
        if (tag !== row.tag_name) changed++;
        const tags = byEntry.get(userEntryId) ?? new Set<string>();
        byEntry.set(userEntryId, tags);
        if (tags.has(tag)) skipped.duplicate++;
        else if (tags.size >= MAX_TAGS_PER_ENTRY) skipped.overLimit++;
        else tags.add(tag);
      }
      report.skip(login, 'tags', 0, 'its entry was not imported', skipped.unmapped);
      report.skip(login, 'tags', 0, 'empty once normalised', skipped.empty);
      report.skip(login, 'tags', 0, 'duplicate once normalised', skipped.duplicate);
      report.skip(
        login,
        'tags',
        0,
        `over ${String(MAX_TAGS_PER_ENTRY)} on one entry`,
        skipped.overLimit,
      );
      if (changed > 0)
        report.note(
          login,
          'tags',
          0,
          `${String(changed)} normalised (lower case, spacing, commas, length)`,
        );
      const values = [...byEntry].flatMap(([userEntryId, tags]) =>
        [...tags].map((tag) => ({ userEntryId, userId, tag })),
      );
      await write(async (tx) => {
        await tx.execute(sql`
          DELETE FROM entry_tags et USING import_map m
          WHERE m.source_table = ${USER_ENTRIES} AND m.user_id = ${userId}
            AND et.user_entry_id = m.target_id`);
        for (let i = 0; i < values.length; i += CHUNK)
          await tx
            .insert(entryTags)
            .values(values.slice(i, i + CHUNK))
            .onConflictDoNothing();
      });
      report.count(login, 'tags', { imported: values.length });
    }
  },
};
