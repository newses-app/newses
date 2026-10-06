import { describe, expect, it } from 'vitest';
import { beforeIdAfter, precedingId, reorder } from './reorder.ts';

const items = [
  { id: 1, sortOrder: 0 },
  { id: 2, sortOrder: 0 },
  { id: 3, sortOrder: 0 },
];

describe('reorder', () => {
  it('places the moved item before the target and renumbers changed items', () => {
    expect(reorder(items, 3, 1)).toEqual([
      { id: 3, sortOrder: 0 },
      { id: 1, sortOrder: 1 },
      { id: 2, sortOrder: 2 },
    ]);
  });

  it('appends when there is no target, including items from elsewhere', () => {
    const numbered = items.map((item, i) => ({ ...item, sortOrder: i }));
    expect(reorder(numbered, 9, null)).toEqual([{ id: 9, sortOrder: 3 }]);
    expect(reorder(numbered, 1, null)).toEqual([
      { id: 2, sortOrder: 0 },
      { id: 3, sortOrder: 1 },
      { id: 1, sortOrder: 2 },
    ]);
  });
});

describe('positions', () => {
  it('turns the item a position follows into the item it goes before', () => {
    expect(beforeIdAfter(items, null)).toBe(1);
    expect(beforeIdAfter(items, 1)).toBe(2);
    expect(beforeIdAfter(items, 3)).toBeNull();
    expect(beforeIdAfter([], null)).toBeNull();
  });

  it('finds the item a position follows', () => {
    expect(precedingId(items, 1)).toBeNull();
    expect(precedingId(items, 3)).toBe(2);
    expect(precedingId(items, 9)).toBeNull();
  });
});
