import type { Category, Label, Prefs } from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import {
  applyResourceOps,
  pendingSubscription,
  refersTo,
  remapIds,
  type ResourceOp,
  temporaryId,
} from './offline-resources.ts';

const categories: Category[] = [
  { id: 1, parentId: null, title: 'News', sortOrder: 0, collapsed: false },
  { id: 2, parentId: 1, title: 'Local', sortOrder: 0, collapsed: false },
];

describe('applyResourceOps', () => {
  it('creates, changes, and deletes categories as the server does, and only once', () => {
    const ops: ResourceOp[] = [
      { kind: 'category.create', id: -5, body: { title: 'New', parentId: 1 } },
      { kind: 'category.update', id: 2, changes: { title: 'Nearby', parentId: undefined } },
      { kind: 'category.delete', id: 1, parentId: null },
    ];
    const once = applyResourceOps('categories', categories, ops);
    expect(once.map((c) => [c.id, c.title, c.parentId])).toEqual([
      [2, 'Nearby', null],
      [-5, 'New', null],
    ]);
    expect(applyResourceOps('categories', once, ops)).toEqual(once);
  });

  it('moves feeds out of a deleted category, and shows feeds subscribed offline', () => {
    const feed = { ...pendingSubscription(7, { url: 'https://a.example/feed' }), categoryId: 2 };
    const out = applyResourceOps(
      'subscriptions',
      [feed],
      [
        { kind: 'category.delete', id: 2, parentId: 1 },
        { kind: 'subscription.update', id: 7, changes: { title: 'Mine' } },
        { kind: 'subscription.create', id: -1, body: { url: 'https://b.example/rss' } },
      ],
    );
    expect(out.map((s) => [s.id, s.title, s.customTitle, s.categoryId])).toEqual([
      [7, 'Mine', 'Mine', 1],
      [-1, 'b.example', null, null],
    ]);
  });

  it('applies preferences and labels, and leaves other data alone', () => {
    const prefs = applyResourceOps<Prefs>('prefs', DEFAULT_PREFS, [
      { kind: 'prefs', changes: { theme: 'dark' } },
    ]);
    expect(prefs.theme).toBe('dark');
    const labels = applyResourceOps<Label[]>(
      'labels',
      [{ id: 1, caption: 'a', fgColor: '#000000', bgColor: '#ffffff' }],
      [
        { kind: 'label.update', id: 1, changes: { caption: 'b' } },
        {
          kind: 'label.create',
          id: -2,
          body: { caption: 'c', fgColor: '#000000', bgColor: '#ffffff' },
        },
      ],
    );
    expect(labels.map((l) => l.caption)).toEqual(['b', 'c']);
    expect(applyResourceOps('tags', ['x'], [{ kind: 'prefs', changes: {} }])).toEqual(['x']);
  });
});

describe('remapIds', () => {
  it('points changes at the id the server gave a new object', () => {
    expect(
      remapIds(
        { kind: 'subscription.update', id: 4, changes: { categoryId: -1 } },
        'category',
        -1,
        9,
      ),
    ).toEqual({ kind: 'subscription.update', id: 4, changes: { categoryId: 9 } });
    expect(
      remapIds({ kind: 'category.update', id: -1, changes: {} }, 'category', -1, 9),
    ).toMatchObject({
      id: 9,
    });
    expect(
      remapIds({ kind: 'labels', id: 3, labelIds: [1, -2], base: [-2] }, 'label', -2, 8),
    ).toEqual({
      kind: 'labels',
      id: 3,
      labelIds: [1, 8],
      base: [8],
    });
    expect(remapIds({ kind: 'prefs', changes: { appearanceTheme: -3 } }, 'theme', -3, 6)).toEqual({
      kind: 'prefs',
      changes: { appearanceTheme: 6 },
    });
    // An entry's id is not a label's.
    expect(refersTo({ kind: 'labels', id: -2, labelIds: [] }, 'label', -2)).toBe(false);
    expect(
      refersTo({ kind: 'markRead', request: { subscriptionId: -4 } }, 'subscription', -4),
    ).toBe(true);
  });

  it('gives temporary ids below zero, each different', () => {
    const a = temporaryId(1000);
    const b = temporaryId(1000);
    expect(a).toBeLessThan(0);
    expect(a).not.toBe(b);
  });
});
