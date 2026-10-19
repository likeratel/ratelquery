import type { GridCopyKind } from "../../lib/gridCopy"
import { formatShortcut } from "../../lib/shortcuts"
import type { MenuItem } from "../ui/Menu"
import {
  CLEAR_SELECTION_SHORTCUT,
  COPY_CELL_SHORTCUT,
  COPY_ROW_SHORTCUT,
  SELECT_ALL_ROWS_SHORTCUT,
} from "./gridShortcuts"

export interface CopyMenuOptions {
  /** Rows the row items copy: the selection, or else the focused or clicked row. */
  targetCount: number
  /** Whether there is a cell for "Copy cell". */
  hasCell: boolean
  /** Row selection, or null when the grid doesn't select rows. */
  selection: { selected: number; total: number } | null
  onCopy: (kind: GridCopyKind) => void
  onSelectAll: () => void
  onClearSelection: () => void
}

/** Items of the grid's copy menus (the toolbar dropdown and the context menu). */
export function copyMenuItems(options: CopyMenuOptions): MenuItem[] {
  const { targetCount, selection, onCopy } = options
  const noun = targetCount === 1 ? "row" : "rows"
  const rowsSelected = (selection?.selected ?? 0) > 0
  const copyItems: MenuItem[] = [
    {
      id: "copy-rows",
      label: `Copy ${noun}`,
      disabled: targetCount === 0,
      shortcut: rowsSelected ? formatShortcut(COPY_CELL_SHORTCUT) : undefined,
      onSelect: () => onCopy("rows"),
    },
    {
      id: "copy-rows-with-names",
      label: `Copy ${noun} with column names`,
      disabled: targetCount === 0,
      shortcut: formatShortcut(COPY_ROW_SHORTCUT),
      onSelect: () => onCopy("rows-with-names"),
    },
    {
      id: "copy-cell",
      label: "Copy cell",
      separatorBefore: true,
      disabled: !options.hasCell,
      shortcut: rowsSelected ? undefined : formatShortcut(COPY_CELL_SHORTCUT),
      onSelect: () => onCopy("cell"),
    },
  ]
  if (!selection) return copyItems
  return [
    ...copyItems,
    {
      id: "select-all",
      label: "Select all",
      separatorBefore: true,
      disabled: selection.total === 0 || selection.selected === selection.total,
      shortcut: formatShortcut(SELECT_ALL_ROWS_SHORTCUT),
      onSelect: options.onSelectAll,
    },
    {
      id: "clear-selection",
      label: "Clear selection",
      disabled: !rowsSelected,
      shortcut: formatShortcut(CLEAR_SELECTION_SHORTCUT),
      onSelect: options.onClearSelection,
    },
  ]
}
