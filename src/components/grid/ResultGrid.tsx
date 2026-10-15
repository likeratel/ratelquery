import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { cellToEditText } from "../../lib/cellEdit"
import { cellTone, formatCell } from "../../lib/cellFormat"
import type { DisplayRow } from "../../lib/gridEdits"
import type { Cell, ColumnInfo } from "../../lib/mysql"
import { CellEditor } from "./CellEditor"
import { useColumnWidths } from "./useColumnWidths"
import "./grid.css"

export const ROW_HEIGHT = 26
const GUTTER_WIDTH = 52
const OVERSCAN = 12

export interface GridSelection {
  row: number
  col: number
}

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
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function ResultGrid(props: ResultGridProps) {
  const { columns, sourceRows, rows, editable, selection, onSelect, onCommit } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const { widths, resize } = useColumnWidths(columns, sourceRows)
  const [editing, setEditing] = useState<GridSelection | null>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  })

  useEffect(() => {
    if (selection) virtualizer.scrollToIndex(selection.row, { align: "auto" })
  }, [selection, virtualizer])

  const template = `${GUTTER_WIDTH}px ${widths.map((w) => `${w}px`).join(" ")}`
  const totalWidth = GUTTER_WIDTH + widths.reduce((sum, w) => sum + w, 0)

  const startEdit = (target: GridSelection) => {
    const row = rows[target.row]
    if (!editable || !onCommit || !row || row.deleted) return
    setEditing(target)
  }

  const move = (dRow: number, dCol: number) => {
    const current = selection ?? { row: 0, col: 0 }
    onSelect({
      row: clamp(current.row + dRow, 0, rows.length - 1),
      col: clamp(current.col + dCol, 0, columns.length - 1),
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || rows.length === 0) return
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

  return (
    <div
      className="grid"
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      onKeyDown={onKeyDown}
    >
      <div className="grid__inner" style={{ width: totalWidth }}>
        <GridHeader columns={columns} template={template} widths={widths} onResize={resize} />
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
                  editable={editable}
                  insertPlaceholder={props.insertPlaceholder}
                  onSelect={onSelect}
                  onStartEdit={startEdit}
                />
                {editCol !== null && onCommit && (
                  <div
                    className="grid__editor-slot"
                    style={{
                      left: GUTTER_WIDTH + widths.slice(0, editCol).reduce((s, w) => s + w, 0),
                      width: widths[editCol],
                    }}
                  >
                    <CellEditor
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
    </div>
  )
}

function editInitial(cell: Cell | undefined): string {
  return cell ? cellToEditText(cell) : ""
}

interface GridHeaderProps {
  columns: readonly ColumnInfo[]
  template: string
  widths: readonly number[]
  onResize: (index: number, width: number) => void
}

function GridHeader({ columns, template, widths, onResize }: GridHeaderProps) {
  const startResize = (index: number) => (event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = widths[index]
    handle.setPointerCapture(event.pointerId)
    const onMove = (move: globalThis.PointerEvent) =>
      onResize(index, startWidth + move.clientX - startX)
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  return (
    <div className="grid__header" role="row" style={{ gridTemplateColumns: template }}>
      <span className="grid__corner" />
      {columns.map((column, index) => (
        <span
          key={`${column.name}-${index}`}
          className="grid__th"
          role="columnheader"
          title={`${column.name} · ${column.typeName}${column.nullable ? "" : " · not null"}`}
        >
          <span className="grid__th-name">{column.name}</span>
          <span className="grid__th-type">{column.typeName.toLowerCase()}</span>
          <span
            className="grid__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${column.name}`}
            onPointerDown={startResize(index)}
          />
        </span>
      ))}
    </div>
  )
}

interface GridRowProps {
  row: DisplayRow
  index: number
  template: string
  selectedCol: number | null
  editable: boolean
  insertPlaceholder?: (col: number) => string
  onSelect: (selection: GridSelection) => void
  onStartEdit: (selection: GridSelection) => void
}

function GridRow(props: GridRowProps) {
  const { row, index, template, selectedCol, editable, onSelect, onStartEdit } = props
  const inserted = row.ref.kind === "insert"
  return (
    <div
      className="grid__row"
      role="row"
      data-deleted={row.deleted || undefined}
      data-inserted={inserted || undefined}
      data-selected={selectedCol !== null || undefined}
      style={{ gridTemplateColumns: template }}
    >
      <span
        className="grid__gutter"
        onMouseDown={() => onSelect({ row: index, col: Math.max(0, selectedCol ?? 0) })}
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
          data-editable={editable || undefined}
          onMouseDown={() => onSelect({ row: index, col })}
          onDoubleClick={() => onStartEdit({ row: index, col })}
        >
          {cell ? formatCell(cell) : (props.insertPlaceholder?.(col) ?? "default")}
        </span>
      ))}
    </div>
  )
}
