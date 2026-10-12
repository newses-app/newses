import { createHash } from 'node:crypto';
import { MAX_NOTE_LENGTH } from '@newses/shared';
import { sql } from 'drizzle-orm';
import { accessKeys } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { importedUsers } from './common.ts';
import { USER_ENTRIES } from './entries.ts';

/** A UUID derived from `seed`, so a replaced share link stays the same across re-runs. */
export function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Published-feed keys usable in `/public/feeds/<key>` as they are. */
const KEY = /^[A-Za-z0-9_-]{1,100}$/;
/** TTRSS's Published feed, the only one whose access key is imported. */
const PUBLISHED_FEED = '-2';

interface SourceNoteRow {
  id: number;
  note: string | null;
  uuid: string;
}

interface SourceKeyRow {
  id: number;
  access_key: string;
  feed_id: string;
  is_cat: boolean;
}

/**
 * Notes, share links, and the published feed's key. Share links keep their UUID, so old links
 * keep working through the legacy URL redirect; others get a new one. Re-runs replace notes and
 * share links on imported entries.
 */
export const sharingStep: ImportStep = {
  name: 'notes and sharing',
  async run(context) {
    const { source, map, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const { login } = user;
      const rows = await source.query<SourceNoteRow>(
        `SELECT int_id AS id, note, uuid FROM ttrss_user_entries
         WHERE owner_uid = $1 AND (coalesce(note, '') <> '' OR uuid <> '') ORDER BY int_id`,
        [user.id],
      );
      const entryIds = await map.targets(
        USER_ENTRIES,
        rows.map((r) => r.id),
      );
      const notes = new Map<number, string>();
      const shares = new Map<number, string>();
      const seenShares = new Set<string>();
      for (const row of rows) {
        const userEntryId = entryIds.get(row.id);
        const note = row.note?.trim() ?? '';
        if (note) {
          report.count(login, 'notes', { source: 1 });
          if (userEntryId === undefined)
            report.skip(login, 'notes', row.id, 'its entry was not imported');
          else {
            if (note.length > MAX_NOTE_LENGTH)
              report.note(
                login,
                'notes',
                row.id,
                `shortened to ${String(MAX_NOTE_LENGTH)} characters`,
              );
            // Copies merged into one entry keep both notes.
            const current = notes.get(userEntryId);
            notes.set(
              userEntryId,
              (current ? `${current}\n\n${note}` : note).slice(0, MAX_NOTE_LENGTH),
            );
            report.count(login, 'notes', { imported: 1 });
          }
        }
        if (row.uuid) {
          report.count(login, 'share links', { source: 1 });
          if (userEntryId === undefined) {
            report.skip(login, 'share links', row.id, 'its entry was not imported');
            continue;
          }
          if (shares.has(userEntryId)) {
            report.skip(
              login,
              'share links',
              row.id,
              'its entry is already shared at another link',
            );
            continue;
          }
          let shareId = row.uuid.toLowerCase();
          if (!UUID.test(shareId) || seenShares.has(shareId)) {
            shareId = stableUuid(`ttrss share ${String(row.id)} ${row.uuid}`);
            report.note(
              login,
              'share links',
              row.id,
              'given a new link; the old one stops working',
            );
          }
          seenShares.add(shareId);
          shares.set(userEntryId, shareId);
          report.count(login, 'share links', { imported: 1 });
        }
      }

      const keys = await source.query<SourceKeyRow>(
        'SELECT id, access_key, feed_id, is_cat FROM ttrss_access_keys WHERE owner_uid = $1 ORDER BY id',
        [user.id],
      );
      report.count(login, 'access keys', { source: keys.length });
      let publishedKey: string | null = null;
      for (const key of keys) {
        if (key.feed_id !== PUBLISHED_FEED || key.is_cat) {
          report.skip(
            login,
            'access keys',
            key.id,
            `generated feed ${key.is_cat ? 'of category' : ''}${key.feed_id} is not supported`,
          );
          continue;
        }
        if (!KEY.test(key.access_key)) {
          report.skip(
            login,
            'access keys',
            key.id,
            'the published feed key has characters not allowed here; a new address is made on first use',
          );
          continue;
        }
        publishedKey = key.access_key;
        report.count(login, 'access keys', { imported: 1 });
      }

      await write(async (tx) => {
        // Source wins: notes and links removed in TTRSS are removed here too.
        await tx.execute(sql`
          UPDATE user_entries ue SET note = NULL, share_id = NULL FROM import_map m
          WHERE m.source_table = ${USER_ENTRIES} AND m.user_id = ${userId} AND ue.id = m.target_id
            AND (ue.note IS NOT NULL OR ue.share_id IS NOT NULL)`);
        const ids = [...new Set([...notes.keys(), ...shares.keys()])];
        if (ids.length > 0)
          await tx.execute(sql`
            UPDATE user_entries ue SET note = v.note, share_id = v.share_id::uuid
            FROM unnest(${sql.param(ids)}::bigint[], ${sql.param(ids.map((id) => notes.get(id) ?? null))}::text[],
              ${sql.param(ids.map((id) => shares.get(id) ?? null))}::text[]) AS v(id, note, share_id)
            WHERE ue.id = v.id AND ue.user_id = ${userId}`);
        if (publishedKey)
          await tx
            .insert(accessKeys)
            .values({ userId, purpose: 'published', key: publishedKey })
            .onConflictDoUpdate({
              target: [accessKeys.userId, accessKeys.purpose],
              set: { key: publishedKey },
            });
      });
    }
  },
};
