import type { FilterAction, FilterRule } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import { compilePattern, type FilterDefinition, FilterSet, type FilterSubject } from './engine.ts';

const subject = (changes: Partial<FilterSubject> = {}): FilterSubject => ({
  title: 'Rust 2.0 released',
  content: '<p>The <b>compiler</b> is faster.</p>',
  author: 'Ann',
  link: 'https://news.example/rust',
  tags: ['programming', 'release'],
  subscriptionId: 1,
  categoryId: 10,
  ...changes,
});

const rule = (changes: Partial<FilterRule> = {}): Required<FilterRule> => ({
  field: 'title',
  pattern: 'rust',
  inverse: false,
  subscriptionIds: [],
  categoryIds: [],
  ...changes,
});

let nextId = 1;
const filter = (
  rules: Required<FilterRule>[],
  actions: FilterAction[] = [{ type: 'star' }],
  changes: Partial<FilterDefinition> = {},
): FilterDefinition => ({
  id: nextId++,
  matchAny: false,
  inverse: false,
  rules,
  actions,
  ...changes,
});

/** Category 10 has a subcategory 11; 20 is elsewhere. */
const parents = new Map<number, number | null>([
  [10, null],
  [11, 10],
  [20, null],
]);
const matches = (definition: FilterDefinition, entry = subject()) =>
  new FilterSet([definition], parents).plan(entry) !== null;

describe('filter engine', () => {
  it('matches each field case-insensitively, and tags one by one', () => {
    expect(matches(filter([rule({ pattern: 'RUST' })]))).toBe(true);
    expect(matches(filter([rule({ pattern: '(?-i)RUST' })]))).toBe(false);
    expect(matches(filter([rule({ field: 'content', pattern: 'compiler' })]))).toBe(true);
    expect(matches(filter([rule({ field: 'titleOrContent', pattern: 'faster' })]))).toBe(true);
    expect(matches(filter([rule({ field: 'author', pattern: '^ann$' })]))).toBe(true);
    expect(matches(filter([rule({ field: 'link', pattern: 'news\\.example' })]))).toBe(true);
    expect(matches(filter([rule({ field: 'tag', pattern: '^release$' })]))).toBe(true);
    expect(matches(filter([rule({ field: 'tag', pattern: '^program$' })]))).toBe(false);
    expect(
      matches(filter([rule({ field: 'author', pattern: '.' })]), subject({ author: null })),
    ).toBe(false);
  });

  it('inverts rules and filters, and combines rules with all or any', () => {
    expect(matches(filter([rule({ inverse: true })]))).toBe(false);
    expect(matches(filter([rule()], undefined, { inverse: true }))).toBe(false);
    const two = [rule(), rule({ pattern: 'python' })];
    expect(matches(filter(two))).toBe(false);
    expect(matches(filter(two, undefined, { matchAny: true }))).toBe(true);
    expect(matches(filter([]))).toBe(false);
  });

  it('limits rules to subscriptions and categories with their subcategories', () => {
    expect(matches(filter([rule({ subscriptionIds: [1] })]))).toBe(true);
    expect(matches(filter([rule({ subscriptionIds: [2] })]))).toBe(false);
    expect(matches(filter([rule({ categoryIds: [10] })]), subject({ categoryId: 11 }))).toBe(true);
    expect(matches(filter([rule({ categoryIds: [20] })]), subject({ categoryId: 11 }))).toBe(false);
    expect(matches(filter([rule({ categoryIds: [10] })]), subject({ categoryId: null }))).toBe(
      false,
    );
  });

  it('names the filters that apply, in order, until one stops', () => {
    const tagged = filter([rule()], [{ type: 'tag', tag: 'rust' }]);
    const other = filter([rule({ pattern: 'python' })]);
    const stopping = filter([rule({ field: 'author', pattern: 'ann' })], [{ type: 'stop' }]);
    const after = filter([rule()]);
    expect(new FilterSet([tagged, other, stopping, after], parents).matching(subject())).toEqual([
      tagged.id,
      stopping.id,
    ]);
  });

  it('combines the actions of matching filters in order, until one stops', () => {
    const set = new FilterSet(
      [
        filter(
          [rule()],
          [
            { type: 'label', labelId: 5 },
            { type: 'score', score: 900_000 },
            { type: 'tag', tag: 'rust' },
          ],
        ),
        filter([rule({ pattern: 'nothing' })], [{ type: 'delete' }]),
        filter(
          [rule()],
          [{ type: 'score', score: 900_000 }, { type: 'markRead' }, { type: 'stop' }],
        ),
        filter([rule()], [{ type: 'publish' }]),
      ],
      parents,
    );
    expect(set.plan(subject())).toEqual({
      delete: false,
      markRead: true,
      star: false,
      publish: false,
      labelIds: new Set([5]),
      tags: new Set(['rust']),
      score: 1_000_000,
    });
    expect(set.plan(subject({ title: 'Go' }))).toBeNull();
  });

  it('refuses patterns RE2 cannot run, and skips stored filters that no longer compile', () => {
    expect(() => compilePattern('(?<=a)b')).toThrow(/Invalid pattern/);
    expect(() => compilePattern('(a)\\1')).toThrow(/Invalid pattern/);
    const set = new FilterSet([filter([rule({ pattern: '(' })]), filter([rule()])], parents);
    expect(set.size).toBe(1);
  });
});
