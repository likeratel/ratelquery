import type { DropPosition, FolderId, LayoutRef } from "../../lib/connectionLayout"

/**
 * Tree key of a folder row. Starts with a control character no connection id (a UUID) or schema
 * key starts with, so folder and connection keys never collide.
 */
export const folderKey = (id: FolderId) => `\u0002${id}`

/** Pointer travel before a press on a row turns into a drag. */
export const DRAG_THRESHOLD_PX = 4

/** Share of a folder row's height at its top and bottom that drops before / after it. */
const FOLDER_EDGE = 0.25

/**
 * Where a drag lands on `target` with the pointer at `fraction` (0 top, 1 bottom) of the row's
 * height. A connection over the middle of a folder row goes inside it; everything else lands
 * before the upper half and after the lower half.
 */
export function dropPosition(ref: LayoutRef, target: LayoutRef, fraction: number): DropPosition {
  if (ref.type === "connection" && target.type === "folder") {
    if (fraction < FOLDER_EDGE) return "before"
    if (fraction > 1 - FOLDER_EDGE) return "after"
    return "inside"
  }
  return fraction < 0.5 ? "before" : "after"
}

/** Data attributes that make a row's line a drag handle and drop target. */
export const dragAttributes = (ref: LayoutRef) => ({
  "data-drag-type": ref.type,
  "data-drag-id": ref.id,
})

/** The layout item an element marked with `dragAttributes` stands for. */
export function readDragRef(element: Element | null): LayoutRef | null {
  const type = element?.getAttribute("data-drag-type")
  const id = element?.getAttribute("data-drag-id")
  if (!id || (type !== "connection" && type !== "folder")) return null
  return { type, id }
}

export const sameRef = (a: LayoutRef | null, b: LayoutRef | null) =>
  a !== null && b !== null && a.type === b.type && a.id === b.id
