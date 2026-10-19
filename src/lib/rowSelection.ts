/**
 * Selected rows of a result grid, by display index. `anchor` is the row a Shift+click range
 * starts from: the last row clicked on its own or toggled. Every update returns a new value.
 */
export interface RowSelection {
  rows: ReadonlySet<number>
  anchor: number | null
}

export const EMPTY_ROW_SELECTION: RowSelection = { rows: new Set(), anchor: null }

/** Modifiers of a row click: Mod toggles the row, Shift extends from the anchor. */
export interface RowClickModifiers {
  toggle: boolean
  extend: boolean
}

export function selectOnly(index: number): RowSelection {
  return { rows: new Set([index]), anchor: index }
}

export function toggleRow(selection: RowSelection, index: number): RowSelection {
  const rows = new Set(selection.rows)
  if (rows.has(index)) rows.delete(index)
  else rows.add(index)
  return { rows, anchor: index }
}

/** Selects the range from the anchor to `index`, replacing the rest; keeps the anchor. */
export function extendTo(selection: RowSelection, index: number): RowSelection {
  const { anchor } = selection
  if (anchor === null) return selectOnly(index)
  const start = Math.min(anchor, index)
  const length = Math.abs(anchor - index) + 1
  return { rows: new Set(Array.from({ length }, (_, i) => start + i)), anchor }
}

export function selectAll(count: number): RowSelection {
  if (count <= 0) return EMPTY_ROW_SELECTION
  return { rows: new Set(Array.from({ length: count }, (_, i) => i)), anchor: 0 }
}

export function clearSelection(): RowSelection {
  return EMPTY_ROW_SELECTION
}

/** `retainRows` keeps every index below `count`, so the size alone tells. */
export function isAllSelected(selection: RowSelection, count: number): boolean {
  return count > 0 && selection.rows.size === count
}

/** Applies a click on a row: Shift extends, Mod toggles, a plain click selects only that row. */
export function clickRow(
  selection: RowSelection,
  index: number,
  modifiers: RowClickModifiers,
): RowSelection {
  if (modifiers.extend) return extendTo(selection, index)
  if (modifiers.toggle) return toggleRow(selection, index)
  return selectOnly(index)
}

/**
 * Drops rows at or past `count`, for when rows go away (a removed inserted row). Returns the
 * same value when nothing changes, so it can run on every render.
 */
export function retainRows(selection: RowSelection, count: number): RowSelection {
  const outside = [...selection.rows].some((index) => index >= count)
  const anchorOutside = selection.anchor !== null && selection.anchor >= count
  if (!outside && !anchorOutside) return selection
  return {
    rows: new Set([...selection.rows].filter((index) => index < count)),
    anchor: anchorOutside ? null : selection.anchor,
  }
}

/** Selected rows in display order. */
export function selectedRows(selection: RowSelection): number[] {
  return [...selection.rows].sort((a, b) => a - b)
}

/**
 * Whether Mod+C copies rows rather than the focused cell: only when rows beyond the focused one
 * are selected. A plain click or an arrow key selects just the focused row, and copying that
 * row's cell is what the key did before row selection existed.
 */
export function copiesWholeRows(selection: RowSelection, focusedRow: number | null): boolean {
  if (selection.rows.size === 0) return false
  return selection.rows.size > 1 || !selection.rows.has(focusedRow ?? -1)
}

/** Rows a copy acts on: the selection, or else the focused row. */
export function copyTargetRows(selection: RowSelection, focusedRow: number | null): number[] {
  if (selection.rows.size > 0) return selectedRows(selection)
  return focusedRow === null ? [] : [focusedRow]
}
