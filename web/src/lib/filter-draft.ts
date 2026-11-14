// A filter as the filters panel edits it, and the request it sends.
import type {
  Filter,
  FilterAction,
  FilterActionType,
  FilterField,
  FilterRequest,
} from '@newses/shared';

export interface RuleDraft {
  field: FilterField;
  pattern: string;
  inverse: boolean;
  /** `s<id>` for subscriptions, `c<id>` for categories. */
  scope: string[];
}

export interface ActionDraft {
  type: FilterActionType;
  labelId: number | null;
  tag: string;
  /** From a number field, whose `v-model.number` leaves text it cannot parse (an empty field). */
  score: number | string;
}

export interface FilterDraft {
  /** The filter being edited; null for a new one. */
  filter: Filter | null;
  title: string;
  enabled: boolean;
  matchAny: boolean;
  inverse: boolean;
  rules: RuleDraft[];
  actions: ActionDraft[];
}

export const newRule = (): RuleDraft => ({
  field: 'title',
  pattern: '',
  inverse: false,
  scope: [],
});
export const newAction = (): ActionDraft => ({
  type: 'markRead',
  labelId: null,
  tag: '',
  score: 0,
});

/** A new filter: enabled, with one empty rule and one action. */
export const newDraft = (): FilterDraft => ({
  filter: null,
  title: '',
  enabled: true,
  matchAny: false,
  inverse: false,
  rules: [newRule()],
  actions: [newAction()],
});

/** A saved filter to edit. */
export function draftOf(filter: Filter): FilterDraft {
  return {
    filter,
    title: filter.title,
    enabled: filter.enabled,
    matchAny: filter.matchAny,
    inverse: filter.inverse,
    rules: filter.rules.map((r) => ({
      field: r.field,
      pattern: r.pattern,
      inverse: r.inverse,
      scope: [
        ...r.categoryIds.map((id) => `c${String(id)}`),
        ...r.subscriptionIds.map((id) => `s${String(id)}`),
      ],
    })),
    actions: filter.actions.map((a) => ({
      type: a.type,
      labelId: a.type === 'label' ? a.labelId : null,
      tag: a.type === 'tag' ? a.tag : '',
      score: a.type === 'score' ? a.score : 0,
    })),
  };
}

const ids = (scope: string[], prefix: string) =>
  scope.filter((s) => s.startsWith(prefix)).map((s) => Number(s.slice(1)));

function toAction(action: ActionDraft): FilterAction {
  switch (action.type) {
    case 'label':
      return { type: 'label', labelId: action.labelId ?? 0 };
    case 'tag':
      return { type: 'tag', tag: action.tag.trim() };
    case 'score':
      return { type: 'score', score: Math.trunc(Number(action.score)) };
    default:
      return { type: action.type };
  }
}

export function filterRequest(draft: FilterDraft): FilterRequest {
  return {
    title: draft.title.trim(),
    enabled: draft.enabled,
    matchAny: draft.matchAny,
    inverse: draft.inverse,
    rules: draft.rules.map((r) => ({
      field: r.field,
      pattern: r.pattern,
      inverse: r.inverse,
      categoryIds: ids(r.scope, 'c'),
      subscriptionIds: ids(r.scope, 's'),
    })),
    actions: draft.actions.map(toAction),
  };
}

/** Whether the draft can be saved or tested: named, every rule with a pattern, every action whole. */
export const draftComplete = (draft: FilterDraft | null) =>
  !!draft?.title.trim() &&
  draft.rules.length > 0 &&
  draft.rules.every((r) => r.pattern) &&
  draft.actions.length > 0 &&
  draft.actions.every(
    (a) => (a.type !== 'label' || a.labelId !== null) && (a.type !== 'tag' || a.tag.trim()),
  );

/** The filters' order with `id` moved `offset` places; null when that leaves the list. */
export function movedOrder(order: readonly number[], id: number, offset: number): number[] | null {
  const index = order.indexOf(id);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= order.length) return null;
  const moved = [...order];
  [moved[index], moved[target]] = [moved[target] ?? id, id];
  return moved;
}
