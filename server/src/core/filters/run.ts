import { type FilterAction, MAX_SCORE, MAX_TAGS_PER_ENTRY, normaliseTag } from '@newses/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { KEPT_ENTRY } from '../feeds/purge.ts';
import { type FilterDefinition, type FilterPlan, FilterSet, type FilterSubject } from './engine.ts';

/** A connection or transaction filters read and write through. */
export type Executor = Pick<Db, 'execute'>;

const ids = (list: number[]) => sql`${sql.param(list)}::bigint[]`;

/** An action as stored: the column for its type is set, the others null. */
interface ActionRow {
  type: FilterAction['type'];
  labelId: number | null;
  tag: string | null;
  score: number | null;
}

interface DefinitionRow extends Record<string, unknown> {
  id: number;
  user_id: number;
  match_any: boolean;
  inverse: boolean;
  rules: FilterDefinition['rules'];
  actions: ActionRow[];
}

/** Filters as stored, rules and actions in order; `filterId` selects one, else enabled ones. */
export async function loadDefinitions(
  executor: Executor,
  userIds: number[],
  filterId?: number,
): Promise<Map<number, FilterDefinition[]>> {
  const byUser = new Map<number, FilterDefinition[]>();
  if (userIds.length === 0) return byUser;
  const result = await executor.execute<DefinitionRow>(sql`
    SELECT f.id, f.user_id, f.match_any, f.inverse,
      coalesce((SELECT json_agg(json_build_object('field', r.field, 'pattern', r.pattern,
          'inverse', r.inverse, 'subscriptionIds', r.subscription_ids,
          'categoryIds', r.category_ids) ORDER BY r.position)
        FROM filter_rules r WHERE r.filter_id = f.id), '[]') AS rules,
      coalesce((SELECT json_agg(json_build_object('type', a.type, 'labelId', a.label_id,
          'tag', a.tag, 'score', a.score) ORDER BY a.position)
        FROM filter_actions a WHERE a.filter_id = f.id), '[]') AS actions
    FROM filters f
    WHERE f.user_id = ANY(${sql.param(userIds)}::int[])
      AND ${filterId === undefined ? sql`f.enabled` : sql`f.id = ${filterId}`}
    ORDER BY f.user_id, f.sort_order, f.id`);
  for (const row of result.rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push({
      id: row.id,
      matchAny: row.match_any,
      inverse: row.inverse,
      rules: row.rules,
      actions: row.actions.map(toAction),
    });
    byUser.set(row.user_id, list);
  }
  return byUser;
}

function toAction(row: ActionRow): FilterAction {
  switch (row.type) {
    case 'label':
      return { type: 'label', labelId: row.labelId ?? 0 };
    case 'tag':
      return { type: 'tag', tag: row.tag ?? '' };
    case 'score':
      return { type: 'score', score: row.score ?? 0 };
    default:
      return { type: row.type };
  }
}

/** Each user's categories and their parents, for rule scopes. */
export async function loadCategoryParents(
  executor: Executor,
  userIds: number[],
): Promise<Map<number, Map<number, number | null>>> {
  const result = await executor.execute<{ id: number; user_id: number; parent_id: number | null }>(
    sql`SELECT id, user_id, parent_id FROM categories WHERE user_id = ANY(${sql.param(userIds)}::int[])`,
  );
  const byUser = new Map<number, Map<number, number | null>>();
  for (const row of result.rows) {
    const parents = byUser.get(row.user_id) ?? new Map<number, number | null>();
    parents.set(row.id, row.parent_id);
    byUser.set(row.user_id, parents);
  }
  return byUser;
}

/** The fields filters match, of user entries chosen by `condition` on `ue`. */
export async function loadSubjects(
  executor: Executor,
  condition: ReturnType<typeof sql>,
  limit?: number,
): Promise<{ id: number; userId: number; subject: FilterSubject }[]> {
  const result = await executor.execute<{
    id: string;
    user_id: number;
    subscription_id: number | null;
    category_id: number | null;
    title: string | null;
    content: string | null;
    author: string | null;
    link: string | null;
    tags: string[];
  }>(sql`
    SELECT ue.id, ue.user_id, ue.subscription_id, s.category_id, e.title, e.content, e.author,
      e.link, array(SELECT et.tag FROM entry_tags et WHERE et.user_entry_id = ue.id) AS tags
    FROM user_entries ue
    JOIN entries e ON e.id = ue.entry_id
    LEFT JOIN subscriptions s ON s.id = ue.subscription_id
    WHERE ${condition}
    ORDER BY ue.id DESC
    ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    userId: row.user_id,
    subject: {
      title: row.title,
      content: row.content,
      author: row.author,
      link: row.link,
      tags: row.tags,
      subscriptionId: row.subscription_id,
      categoryId: row.category_id,
    },
  }));
}

/**
 * Applies filter plans to one user's entries. With `spareKept`, entries the user kept (starred,
 * published, noted, labelled, shared) are not deleted, for filters applied to existing entries.
 */
export async function applyPlans(
  executor: Executor,
  userId: number,
  plans: Map<number, FilterPlan>,
  options: { spareKept: boolean },
): Promise<void> {
  const where = (pick: (plan: FilterPlan) => boolean) =>
    [...plans].filter(([, plan]) => pick(plan)).map(([id]) => id);
  const own = sql`ue.user_id = ${userId}`;

  const doomed = where((p) => p.delete);
  if (doomed.length > 0)
    await executor.execute(sql`
      DELETE FROM user_entries ue WHERE ${own} AND ue.id = ANY(${ids(doomed)})
      ${options.spareKept ? sql`AND NOT ${KEPT_ENTRY}` : sql``}`);
  const live = new Map([...plans].filter(([, plan]) => !plan.delete));
  const pick = (p: (plan: FilterPlan) => boolean) =>
    [...live].filter(([, plan]) => p(plan)).map(([id]) => id);

  const read = pick((p) => p.markRead);
  if (read.length > 0)
    await executor.execute(sql`
      UPDATE user_entries ue SET unread = false, read_at = now()
      WHERE ${own} AND ue.id = ANY(${ids(read)}) AND ue.unread`);
  for (const [column, chosen] of [
    ['starred', pick((p) => p.star)],
    ['published', pick((p) => p.publish)],
  ] as const)
    if (chosen.length > 0)
      await executor.execute(sql`
        UPDATE user_entries ue SET ${sql.raw(column)} = true
        WHERE ${own} AND ue.id = ANY(${ids(chosen)}) AND NOT ue.${sql.raw(column)}`);

  const scored = [...live].filter(([, plan]) => plan.score !== 0);
  if (scored.length > 0)
    await executor.execute(sql`
      UPDATE user_entries ue
      SET score = greatest(${-MAX_SCORE}, least(${MAX_SCORE}, ue.score + d.delta))
      FROM unnest(${ids(scored.map(([id]) => id))}, ${sql.param(scored.map(([, p]) => p.score))}::int[])
        AS d(id, delta)
      WHERE ${own} AND ue.id = d.id`);

  const labelled = [...live].flatMap(([id, plan]) =>
    [...plan.labelIds].map((labelId) => [id, labelId]),
  );
  if (labelled.length > 0)
    await executor.execute(sql`
      INSERT INTO entry_labels (user_entry_id, label_id)
      SELECT p.ue, p.label FROM unnest(${ids(labelled.map(([id]) => id ?? 0))},
          ${sql.param(labelled.map(([, label]) => label ?? 0))}::int[]) AS p(ue, label)
      JOIN user_entries ue ON ue.id = p.ue AND ${own}
      JOIN labels l ON l.id = p.label AND l.user_id = ${userId}
      ON CONFLICT DO NOTHING`);

  const tagged = [...live].flatMap(([id, plan]) =>
    [...plan.tags].flatMap((text) => {
      const tag = normaliseTag(text);
      return tag ? [[id, tag] as const] : [];
    }),
  );
  if (tagged.length > 0)
    await executor.execute(sql`
      INSERT INTO entry_tags (user_entry_id, user_id, tag)
      SELECT p.ue, ${userId}, p.tag
      FROM unnest(${ids(tagged.map(([id]) => id))}, ${sql.param(tagged.map(([, tag]) => tag))}::text[])
        AS p(ue, tag)
      JOIN user_entries ue ON ue.id = p.ue AND ${own}
      WHERE (SELECT count(*) FROM entry_tags et WHERE et.user_entry_id = p.ue) < ${MAX_TAGS_PER_ENTRY}
      ON CONFLICT DO NOTHING`);
}

/** Runs each user's enabled filters over entries just delivered to them (ingest, backfill). */
export async function runFilters(executor: Executor, delivered: { id: number; userId: number }[]) {
  if (delivered.length === 0) return;
  const userIds = [...new Set(delivered.map((d) => d.userId))];
  const definitions = await loadDefinitions(executor, userIds);
  if (definitions.size === 0) return;
  const parents = await loadCategoryParents(executor, [...definitions.keys()]);
  const wanted = delivered.filter((d) => definitions.has(d.userId)).map((d) => d.id);
  const subjects = await loadSubjects(executor, sql`ue.id = ANY(${ids(wanted)})`);
  const sets = new Map(
    [...definitions].map(([userId, list]) => [
      userId,
      new FilterSet(list, parents.get(userId) ?? new Map<number, number | null>()),
    ]),
  );
  const plans = new Map<number, Map<number, FilterPlan>>();
  for (const { id, userId, subject } of subjects) {
    const plan = sets.get(userId)?.plan(subject);
    if (!plan) continue;
    const userPlans = plans.get(userId) ?? new Map<number, FilterPlan>();
    userPlans.set(id, plan);
    plans.set(userId, userPlans);
  }
  for (const [userId, userPlans] of plans)
    await applyPlans(executor, userId, userPlans, { spareKept: false });
}
