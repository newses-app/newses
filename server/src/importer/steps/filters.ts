import { type FilterAction, type FilterField, MAX_SCORE, normaliseTag } from '@newses/shared';
import { and, eq } from 'drizzle-orm';
import { DomainError } from '../../core/errors.ts';
import { compilePattern } from '../../core/filters/engine.ts';
import { filterActions, filterRules, filters, labels } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { CATEGORIES } from './categories.ts';
import { importedUsers } from './common.ts';
import { FEEDS } from './feeds.ts';

export const FILTERS = 'ttrss_filters2';

/** TTRSS rule types (`ttrss_filter_types.name`) and the fields they match here. */
const FIELDS: Record<string, FilterField> = {
  title: 'title',
  content: 'content',
  both: 'titleOrContent',
  link: 'link',
  author: 'author',
  tag: 'tag',
};

/**
 * A PCRE pattern as RE2 accepts it: `\Z` becomes `\z`, `\h` horizontal space, `\R` a line
 * break. Escape pairs are read left to right, so an escaped backslash is left alone.
 */
export function translatePattern(pattern: string): string {
  return pattern.replace(/\\(.)/gs, (pair, char: string) => {
    if (char === 'Z') return '\\z';
    if (char === 'h') return '[ \\t]';
    if (char === 'R') return '(?:\\r\\n|\\n|\\r)';
    return pair;
  });
}

/** Subscription and category ids from TTRSS's `match_on` (`["12", "CAT:3"]`; `"0"` is all feeds). */
function scopeOf(row: SourceRuleRow): { feeds: number[]; categories: number[] } {
  const feeds: number[] = [];
  const categories: number[] = [];
  let items: unknown;
  try {
    items = row.match_on ? JSON.parse(row.match_on) : [];
  } catch {
    items = [];
  }
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item);
    const category = /^CAT:(\d+)$/.exec(text)?.[1];
    if (category && category !== '0') categories.push(Number(category));
    else if (/^\d+$/.test(text) && text !== '0') feeds.push(Number(text));
  }
  // Rules saved before `match_on` existed scope by one feed or category.
  if (feeds.length === 0 && categories.length === 0) {
    if (row.cat_filter && row.cat_id !== null) categories.push(row.cat_id);
    else if (!row.cat_filter && row.feed_id !== null) feeds.push(row.feed_id);
  }
  return { feeds, categories };
}

interface SourceFilterRow {
  id: number;
  title: string;
  enabled: boolean;
  match_any_rule: boolean;
  inverse: boolean;
  order_id: number;
}

interface SourceRuleRow {
  filter_id: number;
  reg_exp: string;
  inverse: boolean;
  type: string | null;
  feed_id: number | null;
  cat_id: number | null;
  cat_filter: boolean;
  match_on: string | null;
}

interface SourceActionRow {
  filter_id: number;
  action: string | null;
  action_param: string;
}

/**
 * Filters with their rules and actions. Patterns are translated to RE2 where they can be; a
 * filter with a pattern RE2 cannot run, a date rule, or an action with no equivalent is imported
 * disabled with a note, so its owner can fix it. Re-runs replace imported filters.
 */
export const filtersStep: ImportStep = {
  name: 'filters',
  async run(context) {
    const { source, map, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const { login } = user;
      const rows = await source.query<SourceFilterRow>(
        `SELECT id, title, enabled, match_any_rule, inverse, order_id FROM ttrss_filters2
         WHERE owner_uid = $1 ORDER BY order_id, id`,
        [user.id],
      );
      report.count(login, 'filters', { source: rows.length });
      if (rows.length === 0) continue;
      const ids = rows.map((r) => r.id);
      const [rules, actions] = await Promise.all([
        source.query<SourceRuleRow>(
          `SELECT r.filter_id, r.reg_exp, r.inverse, t.name AS type, r.feed_id, r.cat_id,
             r.cat_filter, r.match_on
           FROM ttrss_filters2_rules r LEFT JOIN ttrss_filter_types t ON t.id = r.filter_type
           WHERE r.filter_id = ANY($1) ORDER BY r.id`,
          [ids],
        ),
        source.query<SourceActionRow>(
          `SELECT a.filter_id, f.name AS action, a.action_param
           FROM ttrss_filters2_actions a LEFT JOIN ttrss_filter_actions f ON f.id = a.action_id
           WHERE a.filter_id = ANY($1) ORDER BY a.id`,
          [ids],
        ),
      ]);
      const feedMap = await map.targets(FEEDS, [
        ...new Set(rules.flatMap((r) => scopeOf(r).feeds)),
      ]);
      const categoryMap = await map.targets(CATEGORIES, [
        ...new Set(rules.flatMap((r) => scopeOf(r).categories)),
      ]);
      const mapped = await map.targets(FILTERS, ids);
      const userLabels = await context.db
        .select({ id: labels.id, caption: labels.caption })
        .from(labels)
        .where(eq(labels.userId, userId));
      const labelNamed = (caption: string) =>
        userLabels.find((l) => l.caption.toLowerCase() === caption.trim().toLowerCase())?.id;

      await write(async (tx) => {
        for (const [order, row] of rows.entries()) {
          const problems: string[] = [];
          const ruleValues = rules
            .filter((r) => r.filter_id === row.id)
            .flatMap((rule) => {
              const field = rule.type ? FIELDS[rule.type] : undefined;
              if (!field) {
                problems.push(`a ${rule.type ?? 'unknown'} rule has no equivalent`);
                return [];
              }
              const pattern = translatePattern(rule.reg_exp);
              try {
                compilePattern(pattern);
              } catch (err) {
                if (!(err instanceof DomainError)) throw err;
                problems.push(`pattern ${rule.reg_exp} cannot be used: ${err.message}`);
              }
              const scope = scopeOf(rule);
              const subscriptionIds = scope.feeds.flatMap((id) => feedMap.get(id) ?? []);
              const categoryIds = scope.categories.flatMap((id) => categoryMap.get(id) ?? []);
              if (
                subscriptionIds.length + categoryIds.length > 0 !==
                scope.feeds.length + scope.categories.length > 0
              )
                problems.push('a rule is limited to feeds or categories that were not imported');
              return [{ field, pattern, inverse: rule.inverse, subscriptionIds, categoryIds }];
            });
          const actionValues = actions
            .filter((a) => a.filter_id === row.id)
            .flatMap((action): FilterAction[] => {
              const param = action.action_param.trim();
              switch (action.action) {
                case 'filter':
                  return [{ type: 'delete' }];
                case 'catchup':
                  return [{ type: 'markRead' }];
                case 'mark':
                  return [{ type: 'star' }];
                case 'publish':
                  return [{ type: 'publish' }];
                case 'stop':
                  return [{ type: 'stop' }];
                case 'score': {
                  const score = Number.parseInt(param, 10);
                  if (Number.isNaN(score)) break;
                  return [
                    { type: 'score', score: Math.max(-MAX_SCORE, Math.min(MAX_SCORE, score)) },
                  ];
                }
                case 'tag':
                  return param.split(',').flatMap((text) => {
                    const tag = normaliseTag(text);
                    return tag ? [{ type: 'tag' as const, tag }] : [];
                  });
                case 'label': {
                  const labelId = labelNamed(param);
                  if (labelId !== undefined) return [{ type: 'label', labelId }];
                  problems.push(`label "${param}" was not imported`);
                  return [];
                }
              }
              problems.push(`the ${action.action ?? 'unknown'} action has no equivalent`);
              return [];
            });
          if (ruleValues.length === 0 || actionValues.length === 0) {
            report.skip(
              login,
              'filters',
              row.id,
              `no ${ruleValues.length === 0 ? 'rule' : 'action'} could be imported${problems.length > 0 ? `: ${problems.join('; ')}` : ''}`,
            );
            continue;
          }
          const enabled = row.enabled && problems.length === 0;
          if (problems.length > 0)
            report.note(login, 'filters', row.id, `imported disabled: ${problems.join('; ')}`);
          const values = {
            title: row.title.trim().slice(0, 200) || `Filter ${String(row.id)}`,
            enabled,
            matchAny: row.match_any_rule,
            inverse: row.inverse,
            sortOrder: order,
          };
          let filterId = mapped.get(row.id);
          if (filterId !== undefined) {
            const [updated] = await tx
              .update(filters)
              .set(values)
              .where(and(eq(filters.id, filterId), eq(filters.userId, userId)))
              .returning({ id: filters.id });
            filterId = updated?.id;
          }
          if (filterId === undefined) {
            const [created] = await tx
              .insert(filters)
              .values({ userId, ...values })
              .returning({ id: filters.id });
            if (!created) throw new Error('Filter insert returned no row');
            filterId = created.id;
          }
          const target = filterId;
          await tx.delete(filterRules).where(eq(filterRules.filterId, target));
          await tx.delete(filterActions).where(eq(filterActions.filterId, target));
          await tx
            .insert(filterRules)
            .values(ruleValues.map((rule, position) => ({ filterId: target, position, ...rule })));
          await tx.insert(filterActions).values(
            actionValues.map((action, position) => ({
              filterId: target,
              position,
              type: action.type,
              labelId: action.type === 'label' ? action.labelId : null,
              tag: action.type === 'tag' ? action.tag : null,
              score: action.type === 'score' ? action.score : null,
            })),
          );
          await map.record(tx, FILTERS, [{ sourceId: row.id, targetId: target, userId }]);
          report.count(login, 'filters', { imported: 1 });
        }
      });
    }
  },
};
