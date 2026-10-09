import type { Filter, FilterAction, FilterRequest } from '@rss-reader/shared';
import { filterRequestSchema, normaliseTag } from '@rss-reader/shared';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { filterActions, filterRules, filters, labels } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';
import type { Realtime } from '../ports.ts';
import { compilePattern, type FilterDefinition, type FilterPlan, FilterSet } from './engine.ts';
import { applyPlans, loadCategoryParents, loadDefinitions, loadSubjects } from './run.ts';

/** Test checks this many of the user's most recent entries. */
const TEST_ENTRIES = 1000;
const TEST_MATCHES = 50;
/** Apply checks entries in batches, and stops to be continued after this long. */
const APPLY_BATCH = 500;
const APPLY_BUDGET_MS = 15_000;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A saved filter as the API shows it. */
function toFilter(
  row: typeof filters.$inferSelect,
  rules: (typeof filterRules.$inferSelect)[],
  actions: (typeof filterActions.$inferSelect)[],
): Filter {
  return {
    id: row.id,
    title: row.title,
    enabled: row.enabled,
    matchAny: row.matchAny,
    inverse: row.inverse,
    sortOrder: row.sortOrder,
    rules: rules.map((r) => ({
      field: r.field as Filter['rules'][number]['field'],
      pattern: r.pattern,
      inverse: r.inverse,
      subscriptionIds: r.subscriptionIds,
      categoryIds: r.categoryIds,
    })),
    actions: actions.map((a): FilterAction => {
      switch (a.type) {
        case 'label':
          return { type: 'label', labelId: a.labelId ?? 0 };
        case 'tag':
          return { type: 'tag', tag: a.tag ?? '' };
        case 'score':
          return { type: 'score', score: a.score ?? 0 };
        default:
          return { type: a.type as 'delete' | 'markRead' | 'star' | 'publish' | 'stop' };
      }
    }),
  };
}

/** Saved filters, and testing and applying them to existing entries. */
export class FilterService {
  readonly #db: Db;
  readonly #realtime: Realtime;

  constructor(db: Db, realtime: Realtime) {
    this.#db = db;
    this.#realtime = realtime;
  }

  async list(userId: number): Promise<Filter[]> {
    const rows = await this.#db
      .select()
      .from(filters)
      .where(eq(filters.userId, userId))
      .orderBy(asc(filters.sortOrder), asc(filters.id));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [rules, actions] = await Promise.all([
      this.#db
        .select()
        .from(filterRules)
        .where(inArray(filterRules.filterId, ids))
        .orderBy(asc(filterRules.position)),
      this.#db
        .select()
        .from(filterActions)
        .where(inArray(filterActions.filterId, ids))
        .orderBy(asc(filterActions.position)),
    ]);
    return rows.map((row) =>
      toFilter(
        row,
        rules.filter((r) => r.filterId === row.id),
        actions.filter((a) => a.filterId === row.id),
      ),
    );
  }

  async get(userId: number, id: number): Promise<Filter> {
    const filter = (await this.list(userId)).find((f) => f.id === id);
    if (!filter) throw new DomainError('not_found', 'Filter not found');
    return filter;
  }

  /** Adds a filter after the user's others. */
  async create(userId: number, request: FilterRequest): Promise<Filter> {
    const filter = await this.#validate(userId, request);
    const id = await this.#db.transaction(async (tx) => {
      const [last] = await tx
        .select({ order: max(filters.sortOrder) })
        .from(filters)
        .where(eq(filters.userId, userId));
      const [row] = await tx
        .insert(filters)
        .values({
          userId,
          title: filter.title,
          enabled: filter.enabled,
          matchAny: filter.matchAny,
          inverse: filter.inverse,
          sortOrder: (last?.order ?? -1) + 1,
        })
        .returning({ id: filters.id });
      if (!row) throw new Error('Filter insert returned no row');
      await this.#writeParts(tx, row.id, filter);
      return row.id;
    });
    return this.get(userId, id);
  }

  /** Replaces a filter's settings, rules, and actions. */
  async update(userId: number, id: number, request: FilterRequest): Promise<Filter> {
    const filter = await this.#validate(userId, request);
    await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .update(filters)
        .set({
          title: filter.title,
          enabled: filter.enabled,
          matchAny: filter.matchAny,
          inverse: filter.inverse,
        })
        .where(and(eq(filters.id, id), eq(filters.userId, userId)))
        .returning({ id: filters.id });
      if (!row) throw new DomainError('not_found', 'Filter not found');
      await tx.delete(filterRules).where(eq(filterRules.filterId, id));
      await tx.delete(filterActions).where(eq(filterActions.filterId, id));
      await this.#writeParts(tx, id, filter);
    });
    return this.get(userId, id);
  }

  async delete(userId: number, id: number): Promise<void> {
    const deleted = await this.#db
      .delete(filters)
      .where(and(eq(filters.id, id), eq(filters.userId, userId)))
      .returning({ id: filters.id });
    if (deleted.length === 0) throw new DomainError('not_found', 'Filter not found');
  }

  /** Puts the user's filters in the given order; filters left out keep their place after them. */
  async reorder(userId: number, filterIds: number[]): Promise<Filter[]> {
    await this.#db.transaction(async (tx) => {
      for (const [index, id] of filterIds.entries())
        await tx
          .update(filters)
          .set({ sortOrder: index })
          .where(and(eq(filters.id, id), eq(filters.userId, userId)));
    });
    return this.list(userId);
  }

  /** Which of the user's most recent entries a filter, saved or not, would match. */
  async test(
    userId: number,
    request: FilterRequest,
  ): Promise<{ checked: number; matched: number; ids: number[] }> {
    const filter = await this.#validate(userId, request);
    const set = new FilterSet(
      [toDefinition(0, filter)],
      (await loadCategoryParents(this.#db, [userId])).get(userId) ??
        new Map<number, number | null>(),
    );
    const subjects = await loadSubjects(this.#db, sql`ue.user_id = ${userId}`, TEST_ENTRIES);
    const matches = subjects.filter(({ subject }) => set.plan(subject) !== null).map((s) => s.id);
    return {
      checked: subjects.length,
      matched: matches.length,
      ids: matches.slice(0, TEST_MATCHES),
    };
  }

  /**
   * Runs a saved filter over the user's existing entries, newest first, sparing kept entries
   * from deletion. Stops after a time budget; continue with the returned cursor.
   */
  async apply(
    userId: number,
    id: number,
    cursor: string | undefined,
  ): Promise<{ checked: number; matched: number; cursor: string | null }> {
    const [definition] = (await loadDefinitions(this.#db, [userId], id)).get(userId) ?? [];
    if (!definition) throw new DomainError('not_found', 'Filter not found');
    const set = new FilterSet(
      [definition],
      (await loadCategoryParents(this.#db, [userId])).get(userId) ??
        new Map<number, number | null>(),
    );
    let before = cursor === undefined ? null : Number(cursor);
    if (before !== null && !Number.isSafeInteger(before))
      throw new DomainError('invalid_input', 'Invalid cursor');
    const started = Date.now();
    let checked = 0;
    let matched = 0;
    for (;;) {
      const subjects = await loadSubjects(
        this.#db,
        sql`ue.user_id = ${userId}${before === null ? sql`` : sql` AND ue.id < ${before}`}`,
        APPLY_BATCH,
      );
      const plans = new Map<number, FilterPlan>();
      for (const { id: entryId, subject } of subjects) {
        const plan = set.plan(subject);
        if (plan) plans.set(entryId, plan);
      }
      if (plans.size > 0)
        await this.#db.transaction((tx) => applyPlans(tx, userId, plans, { spareKept: true }));
      checked += subjects.length;
      matched += plans.size;
      if (subjects.length < APPLY_BATCH) {
        before = null;
        break;
      }
      before = subjects.at(-1)?.id ?? null;
      if (Date.now() - started > APPLY_BUDGET_MS) break;
    }
    if (matched > 0) await this.#realtime.publish(userId, { type: 'counters' });
    return { checked, matched, cursor: before === null ? null : String(before) };
  }

  /** Parses the request, compiles its patterns, and checks its labels are the user's. */
  async #validate(userId: number, request: FilterRequest) {
    const filter = filterRequestSchema.parse(request);
    for (const rule of filter.rules) compilePattern(rule.pattern);
    for (const action of filter.actions)
      if (action.type === 'tag' && !normaliseTag(action.tag))
        throw new DomainError('invalid_input', 'Tag is empty');
    const labelIds = filter.actions.flatMap((a) => (a.type === 'label' ? [a.labelId] : []));
    if (labelIds.length > 0) {
      const owned = await this.#db
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.userId, userId), inArray(labels.id, labelIds)));
      if (owned.length !== new Set(labelIds).size)
        throw new DomainError('not_found', 'Label not found');
    }
    return filter;
  }

  async #writeParts(
    tx: Tx,
    filterId: number,
    filter: ReturnType<typeof filterRequestSchema.parse>,
  ) {
    await tx
      .insert(filterRules)
      .values(filter.rules.map((rule, position) => ({ filterId, position, ...rule })));
    await tx.insert(filterActions).values(
      filter.actions.map((action, position) => ({
        filterId,
        position,
        type: action.type,
        labelId: action.type === 'label' ? action.labelId : null,
        tag: action.type === 'tag' ? normaliseTag(action.tag) : null,
        score: action.type === 'score' ? action.score : null,
      })),
    );
  }
}

function toDefinition(
  id: number,
  filter: ReturnType<typeof filterRequestSchema.parse>,
): FilterDefinition {
  return {
    id,
    matchAny: filter.matchAny,
    inverse: filter.inverse,
    rules: filter.rules,
    actions: filter.actions,
  };
}
