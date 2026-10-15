import { CircleSlash, Plus, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { ResultGrid, type GridSelection } from "../../components/grid/ResultGrid"
import { parseCellInput } from "../../lib/cellEdit"
import {
  addInsert,
  displayRows,
  EMPTY_EDITS,
  removeInsert,
  setCellEdit,
  setInsertValue,
  toggleRowDelete,
  type DisplayRow,
  type EditTargetResult,
  type RowRef,
} from "../../lib/gridEdits"
import type { RowsResult } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import { useTabsStore } from "../../state/tabsStore"
import { ExportMenu } from "./ExportMenu"
import { PendingBar } from "./PendingBar"
import { ResultMeta } from "./ResultMeta"
import { toast } from "./toastStore"

interface RowsViewProps {
  tab: QueryTab
  index: number
  result: RowsResult
  edit: EditTargetResult
}

export function RowsView({ tab, index, result, edit }: RowsViewProps) {
  const updateEdits = useTabsStore((s) => s.updateEdits)
  const edits = tab.edits[index] ?? EMPTY_EDITS
  const rows = useMemo(
    () => displayRows(result.rows, result.columns.length, edits),
    [result, edits],
  )
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const target = edit.editable ? edit.target : null
  const selectedRow = selection ? rows[selection.row] : undefined

  const commit = (row: DisplayRow, col: number, text: string): string | null => {
    if (!target) return "This result is read only"
    const schemaColumn = target.schemaColumns[col]
    const column = {
      name: schemaColumn.name,
      typeName: schemaColumn.typeName,
      nullable: schemaColumn.nullable,
    }
    const original = row.ref.kind === "existing" ? result.rows[row.ref.index][col] : undefined
    const parsed = parseCellInput(text, column, original)
    if (!parsed.ok) return parsed.error
    const ref = row.ref
    updateEdits(tab.id, index, (current) =>
      ref.kind === "existing"
        ? setCellEdit(current, result.rows, ref.index, col, parsed.cell)
        : setInsertValue(current, ref.id, col, parsed.cell),
    )
    return null
  }

  const toggleDelete = (ref: RowRef) =>
    updateEdits(tab.id, index, (current) =>
      ref.kind === "existing" ? toggleRowDelete(current, ref.index) : removeInsert(current, ref.id),
    )

  const addRow = () => {
    updateEdits(tab.id, index, (current) => addInsert(current, crypto.randomUUID()))
    setSelection({ row: rows.length, col: 0 })
  }

  const setNull = () => {
    if (!selection || !selectedRow || selectedRow.deleted) return
    const error = commit(selectedRow, selection.col, "NULL")
    if (error) toast(error, "danger")
  }

  const placeholder = (col: number) => {
    const column = target?.schemaColumns[col]
    if (column?.isAutoIncrement) return "auto"
    return "default"
  }

  const selectedNullable = selection
    ? (target?.schemaColumns[selection.col]?.nullable ?? false)
    : false

  return (
    <div className="rows-view">
      <div className="result-toolbar">
        <ResultMeta result={result} runKey={`${tab.id}:${tab.runId}`} />
        <span className="result-toolbar__spacer" />
        {target ? (
          <div className="result-toolbar__group" aria-label="Edit rows">
            <button type="button" className="q-button q-button--ghost" onClick={addRow}>
              <Plus size={12} strokeWidth={2.2} />
              Add row
            </button>
            <button
              type="button"
              className="q-button q-button--ghost"
              disabled={!selectedRow}
              onClick={() => selectedRow && toggleDelete(selectedRow.ref)}
            >
              <Trash2 size={12} strokeWidth={2.2} />
              {selectedRow?.deleted ? "Restore row" : "Delete row"}
            </button>
            <button
              type="button"
              className="q-button q-button--ghost"
              disabled={!selectedRow || selectedRow.deleted || !selectedNullable}
              onClick={setNull}
            >
              <CircleSlash size={12} strokeWidth={2.2} />
              Set NULL
            </button>
          </div>
        ) : (
          !edit.editable && (
            <span className="result-toolbar__readonly" title={edit.reason}>
              Read only
            </span>
          )
        )}
        <ExportMenu
          connectionId={tab.connectionId}
          result={result}
          allowFull={tab.results.length === 1}
          database={tab.database ?? null}
        />
      </div>
      <ResultGrid
        key={`${tab.runId}-${index}`}
        columns={result.columns}
        sourceRows={result.rows}
        rows={rows}
        editable={target !== null}
        selection={selection}
        onSelect={setSelection}
        onCommit={target ? commit : undefined}
        insertPlaceholder={placeholder}
      />
      <PendingBar tab={tab} index={index} />
    </div>
  )
}
