import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react"
import type { ColumnInfo } from "../../lib/mysql"

export interface HeaderSelectAll {
  checked: boolean
  indeterminate: boolean
  onToggle: () => void
}

interface GridHeaderProps {
  columns: readonly ColumnInfo[]
  template: string
  widths: readonly number[]
  onResize: (index: number, width: number) => void
  /** Left offset of the sticky row number corner (the check column's width). */
  gutterLeft: number
  /** The select-all checkbox, when the grid selects rows. */
  selectAll?: HeaderSelectAll
  /** Keeps keyboard focus on the grid when a checkbox is pressed. */
  onCheckboxMouseDown: (event: MouseEvent) => void
}

export function GridHeader(props: GridHeaderProps) {
  const { columns, template, widths, onResize, selectAll } = props
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
      {selectAll && (
        <SelectAllCheckbox selectAll={selectAll} onMouseDown={props.onCheckboxMouseDown} />
      )}
      <span className="grid__corner" style={{ left: props.gutterLeft }} />
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

function SelectAllCheckbox({
  selectAll,
  onMouseDown,
}: {
  selectAll: HeaderSelectAll
  onMouseDown: (event: MouseEvent) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selectAll.indeterminate
  }, [selectAll.indeterminate])
  return (
    <span className="grid__check grid__check--header" role="columnheader">
      <label className="grid__check-hit" onMouseDown={onMouseDown}>
        <input
          ref={ref}
          type="checkbox"
          tabIndex={-1}
          aria-label={selectAll.checked ? "Clear row selection" : "Select all rows"}
          checked={selectAll.checked}
          onChange={selectAll.onToggle}
        />
      </label>
    </span>
  )
}
