import { MAX_CATEGORY_TITLE_LENGTH } from '@newses/shared';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { categories } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import type { Writer } from '../import-map.ts';
import { importedUsers } from './common.ts';

export const CATEGORIES = 'ttrss_feed_categories';

interface SourceCategoryRow {
  id: number;
  title: string;
  parent_cat: number | null;
  order_id: number;
  collapsed: boolean;
}

/** Parents before children; categories in a cycle come last, at the top level. */
function parentsFirst(
  rows: SourceCategoryRow[],
): { row: SourceCategoryRow; parent: number | null }[] {
  const ids = new Set(rows.map((r) => r.id));
  const placed = new Set<number>();
  const ordered: { row: SourceCategoryRow; parent: number | null }[] = [];
  let pending = rows;
  while (pending.length > 0) {
    const ready = pending.filter(
      (r) => r.parent_cat === null || !ids.has(r.parent_cat) || placed.has(r.parent_cat),
    );
    if (ready.length === 0) {
      for (const row of pending) ordered.push({ row, parent: null });
      break;
    }
    for (const row of ready) {
      placed.add(row.id);
      ordered.push({
        row,
        parent: row.parent_cat !== null && ids.has(row.parent_cat) ? row.parent_cat : null,
      });
    }
    pending = pending.filter((r) => !placed.has(r.id));
  }
  return ordered;
}

/** The user's category with this title under `parentId`, other than `exceptId`. */
async function sameTitle(
  tx: Writer,
  userId: number,
  parentId: number | null,
  title: string,
  exceptId?: number,
) {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
        eq(categories.title, title),
        exceptId === undefined ? undefined : ne(categories.id, exceptId),
      ),
    );
  return row?.id;
}

/** Categories with their nesting, order, and collapsed state; re-runs update them. */
export const categoriesStep: ImportStep = {
  name: 'categories',
  async run(context) {
    const { source, map, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const rows = await source.query<SourceCategoryRow>(
        `SELECT id, title, parent_cat, order_id, collapsed FROM ttrss_feed_categories
         WHERE owner_uid = $1 ORDER BY id`,
        [user.id],
      );
      report.count(user.login, 'categories', { source: rows.length });
      if (rows.length === 0) continue;
      const mapped = await map.targets(
        CATEGORIES,
        rows.map((r) => r.id),
      );
      await write(async (tx) => {
        for (const { row, parent } of parentsFirst(rows)) {
          const parentId = parent === null ? null : (mapped.get(parent) ?? null);
          const title = row.title.trim().slice(0, MAX_CATEGORY_TITLE_LENGTH) || 'Untitled';
          const values = { title, parentId, sortOrder: row.order_id, collapsed: row.collapsed };
          let targetId = mapped.get(row.id);
          if (targetId !== undefined) {
            const [updated] = await tx
              .update(categories)
              .set(
                (await sameTitle(tx, userId, parentId, title, targetId)) === undefined
                  ? values
                  : { parentId, sortOrder: row.order_id, collapsed: row.collapsed },
              )
              .where(and(eq(categories.id, targetId), eq(categories.userId, userId)))
              .returning({ id: categories.id });
            if (!updated) targetId = undefined;
          }
          if (targetId === undefined) {
            targetId = await sameTitle(tx, userId, parentId, title);
            if (targetId !== undefined)
              report.note(
                user.login,
                'categories',
                row.id,
                `merged into the existing category "${title}"`,
              );
            else {
              const [created] = await tx
                .insert(categories)
                .values({ userId, ...values })
                .returning({ id: categories.id });
              if (!created) throw new Error('Category insert returned no row');
              targetId = created.id;
            }
          }
          mapped.set(row.id, targetId);
          await map.record(tx, CATEGORIES, [{ sourceId: row.id, targetId, userId }]);
        }
      });
      report.count(user.login, 'categories', { imported: rows.length });
    }
  },
};
