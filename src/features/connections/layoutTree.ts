import type { DropPosition, FolderId, LayoutEntry, LayoutRef } from "../../lib/connectionLayout"
import { isDescendant } from "../schema/treeState"

/**
 * Tree key of a folder row. Starts with a control character no connection id (a UUID) or schema
 * key starts with, so folder and connection keys never collide.
 */
export const folderKey = (id: FolderId) => `\u0002${id}`

/** Pointer travel before a press on a row turns into a drag. */
export const DRAG_THRESHOLD_PX = 4

/** Share of a folder row's height at its top and bottom that drops before / after it. */
const FOLDER_EDGE = 0.25

/** The same for a dragged folder: wider, so folders stay easy to reorder among folders. */
const FOLDER_EDGE_FOR_FOLDER = 0.3

/**
 * Where `ref` dragged over `target` lands with the pointer at `fraction` (0 top, 1 bottom) of
 * the row's height. Anything over the middle of a folder row goes inside it; everything else
 * lands before the upper half and after the lower half.
 */
export function dropPosition(ref: LayoutRef, target: LayoutRef, fraction: number): DropPosition {
  if (target.type === "folder") {
    const edge = ref.type === "folder" ? FOLDER_EDGE_FOR_FOLDER : FOLDER_EDGE
    if (fraction < edge) return "before"
    if (fraction > 1 - edge) return "after"
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

/** React key and tree key of an entry's row. */
export const entryKey = (entry: LayoutEntry) =>
  entry.type === "connection" ? entry.config.id : folderKey(entry.folder.id)

/**
 * Whether tree node `key` is one of the rows `entries` render (or lies under one). Rows in
 * collapsed folders count only with `forceOpen`.
 */
export function showsNode(
  entries: readonly LayoutEntry[],
  key: string,
  forceOpen: boolean,
): boolean {
  return entries.some((entry) => {
    if (entry.type === "connection")
      return key === entry.config.id || isDescendant(key, entry.config.id)
    if (key === folderKey(entry.folder.id)) return true
    return (forceOpen || !entry.folder.collapsed) && showsNode(entry.children, key, forceOpen)
  })
}

export const sameRef = (a: LayoutRef | null, b: LayoutRef | null) =>
  a !== null && b !== null && a.type === b.type && a.id === b.id
