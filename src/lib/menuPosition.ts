export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** Space kept between a floating menu and the window edge. */
export const MENU_EDGE_MARGIN = 4

/**
 * Where a menu opened at `point` (such as the pointer) goes so it stays inside the viewport:
 * it flips to the left of or above the point when it would overflow, then clamps to the edges.
 */
export function placeMenu(
  point: Point,
  menu: Size,
  viewport: Size,
  margin = MENU_EDGE_MARGIN,
): Point {
  return {
    x: placeAxis(point.x, menu.width, viewport.width, margin),
    y: placeAxis(point.y, menu.height, viewport.height, margin),
  }
}

function placeAxis(start: number, size: number, limit: number, margin: number): number {
  const fits = start + size <= limit - margin
  const flipped = fits ? start : start - size
  return Math.max(margin, Math.min(flipped, limit - margin - size))
}
