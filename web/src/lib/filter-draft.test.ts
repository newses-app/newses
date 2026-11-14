import type { Filter } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import {
  draftComplete,
  draftOf,
  filterRequest,
  movedOrder,
  newAction,
  newDraft,
  newRule,
} from './filter-draft.ts';

const filter: Filter = {
  id: 3,
  title: 'Sport',
  enabled: false,
  matchAny: true,
  inverse: false,
  rules: [
    {
      field: 'title',
      pattern: 'football',
      inverse: true,
      categoryIds: [2],
      subscriptionIds: [5, 6],
    },
  ],
  actions: [
    { type: 'label', labelId: 9 },
    { type: 'tag', tag: 'sport' },
    { type: 'score', score: -50 },
    { type: 'markRead' },
  ],
} as Filter;

describe('filter drafts', () => {
  it('starts a new filter enabled, with an empty rule and an action', () => {
    expect(newDraft()).toEqual({
      filter: null,
      title: '',
      enabled: true,
      matchAny: false,
      inverse: false,
      rules: [newRule()],
      actions: [newAction()],
    });
  });

  it('edits a saved filter, and sends it back as it was', () => {
    const draft = draftOf(filter);
    expect(draft.rules[0]?.scope).toEqual(['c2', 's5', 's6']);
    expect(draft.actions.map((a) => [a.type, a.labelId, a.tag, a.score])).toEqual([
      ['label', 9, '', 0],
      ['tag', null, 'sport', 0],
      ['score', null, '', -50],
      ['markRead', null, '', 0],
    ]);
    const { id: _id, ...request } = filter;
    expect(filterRequest(draft)).toEqual(request);
  });

  it('trims the name and tags, and sends whole scores', () => {
    const draft = newDraft();
    draft.title = '  Sport ';
    draft.actions = [
      { ...newAction(), type: 'tag', tag: ' sport ' },
      { ...newAction(), type: 'score', score: 12.7 },
      { ...newAction(), type: 'label' },
    ];
    expect(filterRequest(draft)).toMatchObject({
      title: 'Sport',
      actions: [
        { type: 'tag', tag: 'sport' },
        { type: 'score', score: 12 },
        { type: 'label', labelId: 0 },
      ],
    });
  });

  it('is complete once named, each rule has a pattern, and each action is whole', () => {
    expect(draftComplete(null)).toBe(false);
    const draft = newDraft();
    expect(draftComplete(draft)).toBe(false);
    draft.title = 'Sport';
    expect(draftComplete(draft)).toBe(false);
    draft.rules = [{ ...newRule(), pattern: 'ball' }];
    expect(draftComplete(draft)).toBe(true);
    draft.actions = [{ ...newAction(), type: 'label' }];
    expect(draftComplete(draft)).toBe(false);
    draft.actions = [{ ...newAction(), type: 'tag', tag: ' ' }];
    expect(draftComplete(draft)).toBe(false);
    draft.actions = [];
    expect(draftComplete(draft)).toBe(false);
    draft.actions = [newAction()];
    draft.rules = [];
    expect(draftComplete(draft)).toBe(false);
  });
});

describe('movedOrder', () => {
  it('swaps a filter with its neighbour, but not past either end', () => {
    expect(movedOrder([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(movedOrder([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(movedOrder([1, 2, 3], 1, -1)).toBeNull();
    expect(movedOrder([1, 2, 3], 3, 1)).toBeNull();
    expect(movedOrder([1, 2, 3], 4, -1)).toBeNull();
  });
});
