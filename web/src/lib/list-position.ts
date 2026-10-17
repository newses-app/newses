/**
 * Where a list was scrolled: the first row still in view and how far its top was from the view's
 * top, so the place holds when rows arrive above it or drop out; `scrollTop` serves when that row
 * is gone.
 */
export interface ListPosition {
  key: string | null;
  offset: number;
  scrollTop: number;
}

/** A row's key and its edges, measured in the same coordinates as the view's top. */
export interface RowBox {
  key: string;
  top: number;
  bottom: number;
}

export function capturePosition(
  rows: Iterable<RowBox>,
  viewTop: number,
  scrollTop: number,
): ListPosition {
  for (const row of rows)
    if (row.bottom > viewTop) return { key: row.key, offset: row.top - viewTop, scrollTop };
  return { key: null, offset: 0, scrollTop };
}

/** The scroll offset that puts the position's row back at its distance from the view's top. */
export const anchoredScrollTop = (
  position: ListPosition,
  scrollTop: number,
  rowTop: number,
  viewTop: number,
) => scrollTop + rowTop - viewTop - position.offset;
