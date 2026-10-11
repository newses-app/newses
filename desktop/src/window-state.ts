import type { WindowState } from './settings.ts';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** At least this much of a restored window must be on a screen, or it opens at the default place. */
const MIN_VISIBLE = 100;

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) >= MIN_VISIBLE &&
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) >= MIN_VISIBLE;

/** Whether enough of `bounds` is on one of the screens' work areas to reach the window. */
export const onScreen = (bounds: Rect, workAreas: Rect[]) =>
  workAreas.some((area) => overlap(bounds, area));

/** `size`, shrunk to fit if needed, in the middle of `area`. */
export function centered(size: { width: number; height: number }, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/** The saved window bounds when they are still on one of the screens' work areas. */
export function restoreBounds(saved: WindowState | undefined, workAreas: Rect[]): Rect | null {
  if (!saved) return null;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  const bounds = { x, y, width, height };
  return onScreen(bounds, workAreas) ? bounds : null;
}
