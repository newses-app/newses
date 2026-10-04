export interface Ordered {
  id: number;
  sortOrder: number;
}

/**
 * Places `movedId` among `siblings` (in display order) before `beforeId`, or last when null, and
 * numbers them 0…n. Returns the items whose order changed, always including the moved one.
 */
export function reorder(siblings: Ordered[], movedId: number, beforeId: number | null): Ordered[] {
  const ids = siblings.map((s) => s.id).filter((id) => id !== movedId);
  const at = beforeId === null ? -1 : ids.indexOf(beforeId);
  ids.splice(at === -1 ? ids.length : at, 0, movedId);
  const previous = new Map(siblings.map((s) => [s.id, s.sortOrder]));
  return ids
    .map((id, sortOrder) => ({ id, sortOrder }))
    .filter((item) => item.id === movedId || previous.get(item.id) !== item.sortOrder);
}
