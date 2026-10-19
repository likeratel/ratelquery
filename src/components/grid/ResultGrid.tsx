import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { cellToEditText } from "../../lib/cellEdit"
import { gridCopyText, type GridCopyKind } from "../../lib/gridCopy"
import type { DisplayRow } from "../../lib/gridEdits"
import type { Point } from "../../lib/menuPosition"
import type { Cell, ColumnInfo } from "../../lib/mysql"
import {
  clearSelection,
  clickRow,
  copiesWholeRows,
  copyTargetRows,
  EMPTY_ROW_SELECTION,
  isAllSelected,
  selectAll,
  selectedRows,
  selectOnly,
  toggleRow,
  type RowSelection,
} from "../../lib/rowSelection"
import { isMac, matchesShortcut } from "../../lib/shortcuts"
import { CellEditor } from "./CellEditor"
import { copyToClipboard } from "./clipboard"
import { copyMenuItems } from "./copyMenuItems"
import { GRID_CONTEXT_MENU_CLASS, GridContextMenu } from "./GridContextMenu"
import { GridHeader } from "./GridHeader"
import { GridRow, type GridSelection } from "./GridRow"
import {
  CLEAR_SELECTION_SHORTCUT,
  COPY_CELL_SHORTCUT,
  COPY_ROW_SHORTCUT,
  SELECT_ALL_ROWS_SHORTCUT,
} from "./gridShortcuts"
import { useColumnWidths } from "./useColumnWidths"
import "./grid.css"

export { COPY_CELL_SHORTCUT, COPY_ROW_SHORTCUT } from "./gridShortcuts"
export type { GridSelection } from "./GridRow"

export const ROW_HEIGHT = 26
const GUTTER_WIDTH = 52
const CHECK_WIDTH = 28
const OVERSCAN = 12

/** Updates the row selection from its latest value, like a state setter's updater form. */
export type RowSelectionUpdate = (update: (current: RowSelection) => RowSelection) => void

export interface ResultGridProps {
  columns: readonly ColumnInfo[]
  /** Original rows, used to seed column widths. */
  sourceRows: readonly Cell[][]
  rows: readonly DisplayRow[]
  editable: boolean
  selection: GridSelection | null
  onSelect: (selection: GridSelection) => void
  /** Returns an error message to keep the editor open, or null once the edit is recorded. */
  onCommit?: (row: DisplayRow, col: number, text: string) => string | null
  /** Text shown for unset cells of inserted rows, per column (e.g. "default", "auto"). */
  insertPlaceholder?: (col: number) => string
  /** Identity of the grid (tab and result); resized column widths are kept per key. */
  widthKey?: string
  /**
   * Selected rows. With both this and `onRowSelectionChange` the grid shows row checkboxes and
   * selects rows on click (Mod toggles, Shift extends), Mod+A and Esc.
   */
  rowSelection?: RowSelection
  onRowSelectionChange?: RowSelectionUpdate
}

interface ContextMenuState {
  position: Point
  cell: GridSelection
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Virtualized result grid. Memoized, so parents should pass stable callbacks; rows re-render
 * only when their own props change.
 */
export const ResultGrid = memo(function ResultGrid(props: ResultGridProps) {
  const { columns, sourceRows, rows, editable, selection, onSelect, onCommit } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const { widths, resize } = useColumnWidths(columns, sourceRows, props.widthKey)
  const [editing, setEditing] = useState<GridSelection | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const changeRows = props.rowSelection ? props.onRowSelectionChange : undefined
  const rowSelection = changeRows ? (props.rowSelection ?? EMPTY_ROW_SELECTION) : null
  // A right-clicked row is already in view; scrolling would also close its menu straight away.
  const skipScroll = useRef(false)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  })

  useEffect(() => {
    if (skipScroll.current) {
      skipScroll.current = false
      return
    }
    if (selection) virtualizer.scrollToIndex(selection.row, { align: "auto" })
  }, [selection, virtualizer])

  const checkWidth = rowSelection ? CHECK_WIDTH : 0
  const leadWidth = checkWidth + GUTTER_WIDTH
  const template = `${rowSelection ? `${CHECK_WIDTH}px ` : ""}${GUTTER_WIDTH}px ${widths.map((w) => `${w}px`).join(" ")}`
  const totalWidth = leadWidth + widths.reduce((sum, w) => sum + w, 0)

  // Rows receive stable callbacks that read the latest props, so GridRow's memo holds.
  const latest = useRef({ rows, editable, onCommit, selection, onSelect, changeRows })
  useEffect(() => {
    latest.current = { rows, editable, onCommit, selection, onSelect, changeRows }
  })
  const startEdit = useCallback((target: GridSelection) => {
    const current = latest.current
    const row = current.rows[target.row]
    if (!current.editable || !current.onCommit || !row || row.deleted) return
    setEditing(target)
  }, [])

  const press = useCallback((target: GridSelection, event: MouseEvent) => {
    const mac = isMac()
    // Ctrl+click is a right click on macOS; the context menu handles it.
    if (event.button !== 0 || (mac && event.ctrlKey)) return
    const current = latest.current
    current.onSelect(target)
    const modifiers = { toggle: mac ? event.metaKey : event.ctrlKey, extend: event.shiftKey }
    current.changeRows?.((rows) => clickRow(rows, target.row, modifiers))
  }, [])

  const openMenu = useCallback((target: GridSelection, event: MouseEvent) => {
    event.preventDefault()
    const current = latest.current
    const focused = current.selection
    if (focused?.row !== target.row || focused.col !== target.col) skipScroll.current = true
    current.onSelect(target)
    current.changeRows?.((rows) => (rows.rows.has(target.row) ? rows : selectOnly(target.row)))
    setMenu({ position: { x: event.clientX, y: event.clientY }, cell: target })
  }, [])

  const closeMenu = useCallback(() => {
    setMenu(null)
    skipScroll.current = false
    const active = document.activeElement
    if (!active || active === document.body || active.closest(`.${GRID_CONTEXT_MENU_CLASS}`)) {
      scrollRef.current?.focus()
    }
  }, [])

  const toggle = useCallback((index: number) => {
    latest.current.changeRows?.((rows) => toggleRow(rows, index))
  }, [])

  // A checkbox would otherwise take focus, and the grid's keys would stop working.
  const keepFocus = useCallback((event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    scrollRef.current?.focus()
  }, [])

  const selectEvery = () => changeRows?.(() => selectAll(rows.length))
  const clearRows = () => changeRows?.(() => clearSelection())

  /** Copies `kind` for the given rows and cell; returns false when there is nothing to copy. */
  const copy = (kind: GridCopyKind, targetRows: readonly number[], cell: GridSelection | null) => {
    const columnNames = columns.map((column) => column.name)
    const text = gridCopyText(kind, { rows, columnNames, targetRows, cell })
    if (text === null) return false
    copyToClipboard(text)
    return true
  }

  /** Moves the focused cell; the row selection follows it, like a spreadsheet's. */
  const move = (dRow: number, dCol: number) => {
    const current = selection ?? { row: 0, col: 0 }
    const row = clamp(current.row + dRow, 0, rows.length - 1)
    onSelect({ row, col: clamp(current.col + dCol, 0, columns.length - 1) })
    changeRows?.(() => selectOnly(row))
  }

  /** Handles the copy and row selection shortcuts; returns whether the key was used. */
  const selectionKey = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const selected = rowSelection ?? EMPTY_ROW_SELECTION
    const targets = copyTargetRows(selected, selection?.row ?? null)
    if (matchesShortcut(event, COPY_ROW_SHORTCUT)) return copy("rows-with-names", targets, null)
    if (matchesShortcut(event, COPY_CELL_SHORTCUT)) {
      return copiesWholeRows(selected, selection?.row ?? null)
        ? copy("rows", targets, null)
        : copy("cell", [], selection)
    }
    if (!rowSelection) return false
    if (matchesShortcut(event, SELECT_ALL_ROWS_SHORTCUT)) {
      selectEvery()
      return true
    }
    if (matchesShortcut(event, CLEAR_SELECTION_SHORTCUT) && rowSelection.rows.size > 0) {
      clearRows()
      return true
    }
    return false
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed into the cell editor keep their default behaviour, copy included.
    if (event.target !== event.currentTarget || rows.length === 0) return
    if (selectionKey(event)) {
      event.preventDefault()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const steps: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-20, 0],
      PageDown: [20, 0],
    }
    const step = steps[event.code]
    if (step) {
      event.preventDefault()
      move(step[0], step[1])
    } else if ((event.code === "Enter" || event.code === "F2") && selection) {
      event.preventDefault()
      startEdit(selection)
    }
  }

  const finishEdit = () => {
    setEditing(null)
    scrollRef.current?.focus()
  }

  const menuTargets = (target: GridSelection) =>
    rowSelection?.rows.has(target.row) ? selectedRows(rowSelection) : [target.row]

  return (
    <div
      className="grid"
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      aria-multiselectable={rowSelection ? true : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="grid__inner" style={{ width: totalWidth }}>
        <GridHeader
          columns={columns}
          template={template}
          widths={widths}
          onResize={resize}
          gutterLeft={checkWidth}
          onCheckboxMouseDown={keepFocus}
          selectAll={
            rowSelection
              ? {
                  checked: isAllSelected(rowSelection, rows.length),
                  indeterminate:
                    rowSelection.rows.size > 0 && !isAllSelected(rowSelection, rows.length),
                  onToggle: () =>
                    isAllSelected(rowSelection, rows.length) ? clearRows() : selectEvery(),
                }
              : undefined
          }
        />
        <div className="grid__body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            const editCol = editing?.row === item.index ? editing.col : null
            return (
              <div
                key={item.key}
                className="grid__row-slot"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <GridRow
                  row={row}
                  index={item.index}
                  template={template}
                  selectedCol={selection?.row === item.index ? selection.col : null}
                  rowSelected={rowSelection ? rowSelection.rows.has(item.index) : null}
                  gutterLeft={checkWidth}
                  editable={editable}
                  insertPlaceholder={props.insertPlaceholder}
                  onPress={press}
                  onContextMenu={openMenu}
                  onToggleRow={toggle}
                  onCheckboxMouseDown={keepFocus}
                  onStartEdit={startEdit}
                />
                {editCol !== null && onCommit && (
                  <div
                    className="grid__editor-slot"
                    style={{
                      left: leadWidth + widths.slice(0, editCol).reduce((s, w) => s + w, 0),
                      width: widths[editCol],
                    }}
                  >
                    <CellEditor
                      // Tab moves to the next cell; a fresh editor starts from that cell's value.
                      key={editCol}
                      initial={editInitial(row.cells[editCol])}
                      onCommit={(text) => {
                        const error = onCommit(row, editCol, text)
                        if (error === null) finishEdit()
                        return error
                      }}
                      onCancel={finishEdit}
                      onTab={(backwards) => {
                        const col = clamp(editCol + (backwards ? -1 : 1), 0, columns.length - 1)
                        onSelect({ row: item.index, col })
                        setEditing({ row: item.index, col })
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {menu && (
        <GridContextMenu
          position={menu.position}
          onClose={closeMenu}
          items={copyMenuItems({
            targetCount: menuTargets(menu.cell).length,
            hasCell: true,
            selection: rowSelection
              ? { selected: rowSelection.rows.size, total: rows.length }
              : null,
            onCopy: (kind) => copy(kind, menuTargets(menu.cell), menu.cell),
            onSelectAll: selectEvery,
            onClearSelection: clearRows,
          })}
        />
      )}
    </div>
  )
})

function editInitial(cell: Cell | undefined): string {
  return cell ? cellToEditText(cell) : ""
}
