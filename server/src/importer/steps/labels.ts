import { and, eq, ne, sql } from 'drizzle-orm';
import { entryLabels, labels } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import type { Writer } from '../import-map.ts';
import { importedUsers } from './common.ts';
import { USER_ENTRIES } from './entries.ts';

export const LABELS = 'ttrss_labels2';
const MAX_CAPTION = 100;
/** Colours for labels whose TTRSS colours are not hex: the web app's first label colour. */
const DEFAULT_COLOURS = { fgColor: '#ffffff', bgColor: '#1565c0' };
/** Label assignments written per statement. */
const CHUNK = 5000;

/** `#rrggbb` from TTRSS's `#rgb`, `#rrggbb`, or either without `#`; null for anything else. */
export function hexColour(value: string): string | null {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1]?.toLowerCase();
  if (!hex) return null;
  return `#${hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex}`;
}

interface SourceLabelRow {
  id: number;
  caption: string;
  fg_color: string;
  bg_color: string;
}

/** The user's label whose caption equals `caption` ignoring case, other than `exceptId`. */
async function sameCaption(tx: Writer, userId: number, caption: string, exceptId?: number) {
  const [row] = await tx
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.userId, userId),
        sql`lower(${labels.caption}) = lower(${caption})`,
        exceptId === undefined ? undefined : ne(labels.id, exceptId),
      ),
    );
  return row?.id;
}

/**
 * Labels with their colours (normalised to `#rrggbb`) and their assignments to imported
 * entries. Captions equal ignoring case merge into one label. Re-runs replace the assignments.
 */
export const labelsStep: ImportStep = {
  name: 'labels',
  async run(context) {
    const { source, map, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const { login } = user;
      const rows = await source.query<SourceLabelRow>(
        'SELECT id, caption, fg_color, bg_color FROM ttrss_labels2 WHERE owner_uid = $1 ORDER BY id',
        [user.id],
      );
      report.count(login, 'labels', { source: rows.length });
      const mapped = await map.targets(
        LABELS,
        rows.map((r) => r.id),
      );
      await write(async (tx) => {
        for (const row of rows) {
          const caption = row.caption.trim();
          if (!caption) {
            report.skip(login, 'labels', row.id, 'empty caption');
            continue;
          }
          if (caption.length > MAX_CAPTION)
            report.note(
              login,
              'labels',
              row.id,
              `caption shortened to ${String(MAX_CAPTION)} characters`,
            );
          const fgColor = hexColour(row.fg_color);
          const bgColor = hexColour(row.bg_color);
          if ((row.fg_color && !fgColor) || (row.bg_color && !bgColor))
            report.note(
              login,
              'labels',
              row.id,
              `colours ${row.fg_color}/${row.bg_color} replaced`,
            );
          const values = {
            caption: caption.slice(0, MAX_CAPTION),
            fgColor: fgColor ?? DEFAULT_COLOURS.fgColor,
            bgColor: bgColor ?? DEFAULT_COLOURS.bgColor,
          };
          let targetId = mapped.get(row.id);
          if (targetId !== undefined) {
            const clash = await sameCaption(tx, userId, values.caption, targetId);
            const [updated] = await tx
              .update(labels)
              .set(
                clash === undefined ? values : { fgColor: values.fgColor, bgColor: values.bgColor },
              )
              .where(and(eq(labels.id, targetId), eq(labels.userId, userId)))
              .returning({ id: labels.id });
            targetId = updated?.id;
          }
          if (targetId === undefined) {
            targetId = await sameCaption(tx, userId, values.caption);
            if (targetId !== undefined)
              report.note(
                login,
                'labels',
                row.id,
                'merged with a label whose caption differs only in case',
              );
            else {
              const [created] = await tx
                .insert(labels)
                .values({ userId, ...values })
                .returning({ id: labels.id });
              if (!created) throw new Error('Label insert returned no row');
              targetId = created.id;
            }
          }
          mapped.set(row.id, targetId);
          await map.record(tx, LABELS, [{ sourceId: row.id, targetId, userId }]);
          report.count(login, 'labels', { imported: 1 });
        }
      });

      // Assignments: TTRSS links labels to the shared article; each user's copy carries them.
      const pairs = await source.query<{ label_id: number; int_id: number }>(
        `SELECT ul.label_id, ue.int_id FROM ttrss_user_labels2 ul
         JOIN ttrss_labels2 l ON l.id = ul.label_id
         JOIN ttrss_user_entries ue ON ue.ref_id = ul.article_id AND ue.owner_uid = l.owner_uid
         WHERE l.owner_uid = $1`,
        [user.id],
      );
      report.count(login, 'label assignments', { source: pairs.length });
      const entryIds = await map.targets(USER_ENTRIES, [...new Set(pairs.map((p) => p.int_id))]);
      const wanted = new Map<string, { userEntryId: number; labelId: number }>();
      let unmapped = 0;
      for (const pair of pairs) {
        const userEntryId = entryIds.get(pair.int_id);
        const labelId = mapped.get(pair.label_id);
        if (userEntryId === undefined || labelId === undefined) {
          unmapped++;
          continue;
        }
        wanted.set(`${String(userEntryId)} ${String(labelId)}`, { userEntryId, labelId });
      }
      report.skip(login, 'label assignments', 0, 'its entry or label was not imported', unmapped);
      // Copies merged into one entry carry their labels once.
      report.skip(
        login,
        'label assignments',
        0,
        'duplicate once copies or labels merged',
        pairs.length - unmapped - wanted.size,
      );
      const labelIds = [...new Set(mapped.values())];
      await write(async (tx) => {
        if (labelIds.length > 0)
          await tx.execute(sql`
            DELETE FROM entry_labels el USING import_map m
            WHERE m.source_table = ${USER_ENTRIES} AND m.user_id = ${userId}
              AND el.user_entry_id = m.target_id
              AND el.label_id IN (${sql.join(
                labelIds.map((id) => sql`${id}`),
                sql`, `,
              )})`);
        const rows = [...wanted.values()];
        for (let i = 0; i < rows.length; i += CHUNK)
          await tx
            .insert(entryLabels)
            .values(rows.slice(i, i + CHUNK))
            .onConflictDoNothing();
      });
      report.count(login, 'label assignments', { imported: wanted.size });
    }
  },
};
