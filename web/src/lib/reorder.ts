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

/** Sorts feeds or categories as the tree shows them. */
export const byDisplayOrder = <T extends { sortOrder: number; title: string }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

/**
 * A position among `siblings` (display order, without the moved item) is the id it follows, or
 * null for first. Returns the id it goes before, or null for last, as `reorder` takes it.
 */
export function beforeIdAfter(siblings: Ordered[], after: number | null): number | null {
  const at = after === null ? 0 : siblings.findIndex((s) => s.id === after) + 1;
  return siblings[at]?.id ?? null;
}

/** The id `id` follows among `ordered` (display order), or null when it is first or absent. */
export function precedingId(ordered: Ordered[], id: number): number | null {
  const at = ordered.findIndex((s) => s.id === id);
  return at > 0 ? (ordered[at - 1]?.id ?? null) : null;
}
