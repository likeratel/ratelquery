import { parseShortcut } from "../../lib/shortcuts"

/**
 * Mod+C copies the selected rows, or the focused cell when no row is selected. Mod+Shift+C
 * copies the same rows (the focused cell's row without a selection) under a line of column names.
 */
export const COPY_CELL_SHORTCUT = parseShortcut("Mod+C")
export const COPY_ROW_SHORTCUT = parseShortcut("Mod+Shift+C")
/** Selects every row while the grid has focus. */
export const SELECT_ALL_ROWS_SHORTCUT = parseShortcut("Mod+A")
export const CLEAR_SELECTION_SHORTCUT = parseShortcut("Escape")
