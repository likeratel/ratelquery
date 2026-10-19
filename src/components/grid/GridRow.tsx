import { memo, type MouseEvent } from "react"
import { cellTone, formatCell } from "../../lib/cellFormat"
import type { DisplayRow } from "../../lib/gridEdits"

export interface GridSelection {
  row: number
  col: number
}

export interface GridRowProps {
  row: DisplayRow
  index: number
  template: string
  selectedCol: number | null
  /** Whether the row is in the row selection; null when the grid doesn't select rows. */
  rowSelected: boolean | null
  /** Left offset of the sticky row number (the check column's width). */
  gutterLeft: number
  editable: boolean
  insertPlaceholder?: (col: number) => string
  /** A press on a cell or the row number. */
  onPress: (target: GridSelection, event: MouseEvent) => void
  onContextMenu: (target: GridSelection, event: MouseEvent) => void
  onToggleRow: (index: number) => void
  /** Keeps keyboard focus on the grid when a checkbox is pressed. */
  onCheckboxMouseDown: (event: MouseEvent) => void
  onStartEdit: (selection: GridSelection) => void
}

export const GridRow = memo(function GridRow(props: GridRowProps) {
  const { row, index, template, selectedCol, rowSelected, onPress, onContextMenu } = props
  const inserted = row.ref.kind === "insert"
  const gutterTarget = { row: index, col: Math.max(0, selectedCol ?? 0) }
  return (
    <div
      className="grid__row"
      role="row"
      aria-selected={rowSelected ?? undefined}
      data-deleted={row.deleted || undefined}
      data-inserted={inserted || undefined}
      data-selected={selectedCol !== null || undefined}
      data-row-selected={rowSelected || undefined}
      style={{ gridTemplateColumns: template }}
    >
      {rowSelected !== null && (
        <span className="grid__check" role="gridcell">
          <label className="grid__check-hit" onMouseDown={props.onCheckboxMouseDown}>
            <input
              type="checkbox"
              tabIndex={-1}
              aria-label={`Select row ${index + 1}`}
              checked={rowSelected}
              onChange={() => props.onToggleRow(index)}
            />
          </label>
        </span>
      )}
      <span
        className="grid__gutter"
        style={{ left: props.gutterLeft }}
        onMouseDown={(event) => onPress(gutterTarget, event)}
        onContextMenu={(event) => onContextMenu(gutterTarget, event)}
      >
        {inserted ? "+" : index + 1}
      </span>
      {row.cells.map((cell, col) => (
        <span
          key={col}
          role="gridcell"
          className="grid__td"
          data-tone={cell ? cellTone(cell) : "placeholder"}
          data-changed={row.changed[col] || undefined}
          data-selected={selectedCol === col || undefined}
          data-editable={props.editable || undefined}
          onMouseDown={(event) => onPress({ row: index, col }, event)}
          onContextMenu={(event) => onContextMenu({ row: index, col }, event)}
          onDoubleClick={() => props.onStartEdit({ row: index, col })}
        >
          {cell ? formatCell(cell) : (props.insertPlaceholder?.(col) ?? "default")}
        </span>
      ))}
    </div>
  )
})
