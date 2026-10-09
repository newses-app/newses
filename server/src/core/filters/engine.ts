import { type FilterAction, type FilterRule, MAX_SCORE } from '@rss-reader/shared';
import { RE2JS, RE2JSException } from 're2js';
import { DomainError } from '../errors.ts';

/** A filter as the engine runs it. */
export interface FilterDefinition {
  id: number;
  matchAny: boolean;
  inverse: boolean;
  rules: Required<FilterRule>[];
  actions: FilterAction[];
}

/** What filters match against: one user's entry. */
export interface FilterSubject {
  title: string | null;
  content: string | null;
  author: string | null;
  link: string | null;
  tags: string[];
  subscriptionId: number | null;
  categoryId: number | null;
}

/** The combined effect of the filters that matched one entry. */
export interface FilterPlan {
  delete: boolean;
  markRead: boolean;
  star: boolean;
  publish: boolean;
  labelIds: Set<number>;
  tags: Set<string>;
  score: number;
}

/**
 * Compiles a rule pattern: RE2 syntax, matched case-insensitively (`(?-i)` turns that off), in
 * time linear in the input, so no pattern can stall the server.
 */
export function compilePattern(pattern: string): RE2JS {
  try {
    return RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
  } catch (err) {
    if (!(err instanceof RE2JSException)) throw err;
    throw new DomainError('invalid_input', `Invalid pattern "${pattern}": ${err.message}`);
  }
}

interface CompiledRule {
  field: FilterRule['field'];
  regex: RE2JS;
  inverse: boolean;
  subscriptionIds: Set<number>;
  /** The scope's categories with all their subcategories. */
  categoryIds: Set<number>;
}

interface CompiledFilter {
  definition: FilterDefinition;
  rules: CompiledRule[];
}

/** Each category id with the ids of all its subcategories. */
function withDescendants(ids: number[], parents: Map<number, number | null>): Set<number> {
  const result = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, parent] of parents)
      if (parent !== null && result.has(parent) && !result.has(id)) {
        result.add(id);
        grew = true;
      }
  }
  return result;
}

function ruleMatches(rule: CompiledRule, subject: FilterSubject): boolean {
  const scoped = rule.subscriptionIds.size > 0 || rule.categoryIds.size > 0;
  if (
    scoped &&
    !(subject.subscriptionId !== null && rule.subscriptionIds.has(subject.subscriptionId)) &&
    !(subject.categoryId !== null && rule.categoryIds.has(subject.categoryId))
  )
    return false;
  const test = (text: string | null) => rule.regex.test(text ?? '');
  let matched: boolean;
  switch (rule.field) {
    case 'title':
      matched = test(subject.title);
      break;
    case 'content':
      matched = test(subject.content);
      break;
    case 'titleOrContent':
      matched = test(subject.title) || test(subject.content);
      break;
    case 'author':
      matched = test(subject.author);
      break;
    case 'link':
      matched = test(subject.link);
      break;
    case 'tag':
      matched = subject.tags.some((tag) => rule.regex.test(tag));
      break;
  }
  return matched !== rule.inverse;
}

/** One user's filters, compiled, applied in order until one says stop. */
export class FilterSet {
  readonly #filters: CompiledFilter[];

  /**
   * `categoryParents` maps the user's categories to their parents, for scopes. Filters with a
   * pattern that no longer compiles are left out rather than failing every entry.
   */
  constructor(definitions: FilterDefinition[], categoryParents: Map<number, number | null>) {
    this.#filters = definitions.flatMap((definition) => {
      try {
        return [
          {
            definition,
            rules: definition.rules.map((rule) => ({
              field: rule.field,
              regex: compilePattern(rule.pattern),
              inverse: rule.inverse,
              subscriptionIds: new Set(rule.subscriptionIds),
              categoryIds: withDescendants(rule.categoryIds, categoryParents),
            })),
          },
        ];
      } catch (err) {
        if (err instanceof DomainError) return [];
        throw err;
      }
    });
  }

  get size(): number {
    return this.#filters.length;
  }

  /** Whether the filter matches: any or all of its rules, inverted if it says so. */
  static #matches({ definition, rules }: CompiledFilter, subject: FilterSubject): boolean {
    if (rules.length === 0) return false;
    const matched = definition.matchAny
      ? rules.some((rule) => ruleMatches(rule, subject))
      : rules.every((rule) => ruleMatches(rule, subject));
    return matched !== definition.inverse;
  }

  /** The actions of the filters matching `subject`, combined; null when none matches. */
  plan(subject: FilterSubject): FilterPlan | null {
    let plan: FilterPlan | null = null;
    for (const filter of this.#filters) {
      if (!FilterSet.#matches(filter, subject)) continue;
      plan ??= {
        delete: false,
        markRead: false,
        star: false,
        publish: false,
        labelIds: new Set(),
        tags: new Set(),
        score: 0,
      };
      let stop = false;
      for (const action of filter.definition.actions) {
        switch (action.type) {
          case 'delete':
            plan.delete = true;
            break;
          case 'markRead':
            plan.markRead = true;
            break;
          case 'star':
            plan.star = true;
            break;
          case 'publish':
            plan.publish = true;
            break;
          case 'label':
            plan.labelIds.add(action.labelId);
            break;
          case 'tag':
            plan.tags.add(action.tag);
            break;
          case 'score':
            plan.score = Math.max(-MAX_SCORE, Math.min(MAX_SCORE, plan.score + action.score));
            break;
          case 'stop':
            stop = true;
            break;
        }
      }
      if (stop) break;
    }
    return plan;
  }
}
