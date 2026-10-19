import { CircleSlash, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { copyToClipboard } from "../../components/grid/clipboard"
import { CopyMenu } from "../../components/grid/CopyMenu"
import { ResultGrid, type GridSelection } from "../../components/grid/ResultGrid"
import { NULL_INPUT, parseCellInput } from "../../lib/cellEdit"
import { gridCopyText, type GridCopyKind } from "../../lib/gridCopy"
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
  type GridEdits,
  type RowRef,
} from "../../lib/gridEdits"
import type { RowsResult } from "../../lib/mysql"
import {
  clearSelection,
  copyTargetRows,
  EMPTY_ROW_SELECTION,
  retainRows,
  selectAll,
  type RowSelection,
} from "../../lib/rowSelection"
import { useTabsStore } from "../../state/tabsStore"
import { ResultExportMenu } from "./ExportMenu"
import { PendingBar } from "./PendingBar"
import { ResultMeta } from "./ResultMeta"
import { addedLimitFor, useRunGuardStore } from "./runGuard"
import { showToast } from "../../components/ui"

interface RowsViewProps {
  tabId: string
  connectionId: string
  /** The tab's run counter; a new run remounts the grid. */
  runId: number
  index: number
  result: RowsResult
  edit: EditTargetResult
  /** Pending edits of this result. */
  edits: GridEdits | undefined
  applying: boolean
  /** Full export re-runs the statement, so it is only offered for single-statement runs. */
  allowFull: boolean
  /** Database the result was read from. */
  database: string | null
}

export function RowsView(props: RowsViewProps) {
  const { tabId, connectionId, runId, index, result, edit, applying } = props
  const updateEdits = useTabsStore((s) => s.updateEdits)
  const addedLimit = useRunGuardStore((s) => addedLimitFor(s.limitedByTab[tabId], index))
  const edits = props.edits ?? EMPTY_EDITS
  const rows = useMemo(
    () => displayRows(result.rows, result.columns.length, edits),
    [result, edits],
  )
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const [storedRowSelection, setRowSelection] = useState<RowSelection>(EMPTY_ROW_SELECTION)
  // Removing an inserted row shortens the rows; drop selected indexes that no longer exist.
  const rowSelection = retainRows(storedRowSelection, rows.length)
  if (rowSelection !== storedRowSelection) setRowSelection(rowSelection)
  const target = edit.editable ? edit.target : null
  const selectedRow = selection ? rows[selection.row] : undefined

  const commit = useCallback(
    (row: DisplayRow, col: number, text: string): string | null => {
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
      updateEdits(tabId, index, (current) =>
        ref.kind === "existing"
          ? setCellEdit(current, result.rows, ref.index, col, parsed.cell)
          : setInsertValue(current, ref.id, col, parsed.cell),
      )
      return null
    },
    [target, result.rows, updateEdits, tabId, index],
  )

  const toggleDelete = (ref: RowRef) =>
    updateEdits(tabId, index, (current) =>
      ref.kind === "existing" ? toggleRowDelete(current, ref.index) : removeInsert(current, ref.id),
    )

  const addRow = () => {
    updateEdits(tabId, index, (current) => addInsert(current, crypto.randomUUID()))
    setSelection({ row: rows.length, col: 0 })
  }

  const setNull = () => {
    if (!selection || !selectedRow || selectedRow.deleted) return
    const error = commit(selectedRow, selection.col, NULL_INPUT)
    if (error) showToast({ tone: "error", message: error })
  }

  const placeholder = useCallback(
    (col: number) => (target?.schemaColumns[col]?.isAutoIncrement ? "auto" : "default"),
    [target],
  )

  const copy = (kind: GridCopyKind) => {
    const text = gridCopyText(kind, {
      rows,
      columnNames: result.columns.map((column) => column.name),
      targetRows: copyTargetRows(rowSelection, selection?.row ?? null),
      cell: selection,
    })
    if (text !== null) copyToClipboard(text)
  }
  const selectedCount = rowSelection.rows.size

  const selectedNullable = selection
    ? (target?.schemaColumns[selection.col]?.nullable ?? false)
    : false

  return (
    <div className="rows-view">
      <div className="result-toolbar">
        <ResultMeta result={result} runKey={`${tabId}:${runId}`} />
        {addedLimit !== null && (
          <span
            className="badge"
            title="Added to the executed statement by Settings › Queries. The editor text is unchanged."
          >
            LIMIT {addedLimit.toLocaleString()} added
          </span>
        )}
        <span className="result-toolbar__spacer" />
        {selectedCount > 0 && (
          <span className="result-toolbar__selection" aria-live="polite">
            {selectedCount.toLocaleString()} {selectedCount === 1 ? "row" : "rows"} selected
          </span>
        )}
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
              title={`Same as typing ${NULL_INPUT} in the cell`}
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
        <CopyMenu
          targetCount={
            copyTargetRows(rowSelection, selectedRow ? (selection?.row ?? null) : null).length
          }
          hasCell={selectedRow !== undefined}
          selection={{ selected: selectedCount, total: rows.length }}
          onCopy={copy}
          onSelectAll={() => setRowSelection(selectAll(rows.length))}
          onClearSelection={() => setRowSelection(clearSelection())}
        />
        <ResultExportMenu
          connectionId={connectionId}
          result={result}
          allowFull={props.allowFull}
          database={props.database}
        />
      </div>
      <ResultGrid
        key={`${runId}-${index}`}
        widthKey={`${tabId}:${index}`}
        columns={result.columns}
        sourceRows={result.rows}
        rows={rows}
        editable={target !== null}
        selection={selection}
        onSelect={setSelection}
        onCommit={target ? commit : undefined}
        insertPlaceholder={placeholder}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
      />
      <PendingBar tabId={tabId} index={index} edits={props.edits} applying={applying} />
    </div>
  )
}
