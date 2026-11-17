import { useCallback, useMemo, useState } from "react"
import { ResultGrid, type GridSelection } from "../../components/grid/ResultGrid"
import { Button, showToast } from "../../components/ui"
import { EMPTY_EDITS, displayRows } from "../../lib/gridEdits"
import { EMPTY_ROW_SELECTION, type RowSelection } from "../../lib/rowSelection"
import type { TrashEntry } from "../../lib/trash"
import {
  formatDeletedAt,
  restoreCount,
  restoreOptions,
  statusNote,
  summaryLine,
  trashColumns,
} from "../../lib/trashView"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useTrashStore } from "../../state/trashStore"
import { useUiStore } from "../../state/uiStore"
import { ensureMysqlSession } from "../query/mysqlSession"
import { ConfirmDeleteDialog } from "./TrashDialogs"

/** The open entry: its rows (read only, selectable), the statement and the actions. */
export function TrashDetail() {
  const entry = useTrashStore((s) => s.entry)
  const error = useTrashStore((s) => s.entryError)
  if (error)
    return (
      <p className="trash__error" role="alert">
        Couldn't read this entry: {error}
      </p>
    )
  if (!entry) return <p className="trash__empty">Loading…</p>
  return <EntryView key={entry.id + entry.rows.length} entry={entry} />
}

function EntryView({ entry }: { entry: TrashEntry }) {
  const connections = useConnectionsStore((s) => s.connections)
  const restoring = useTrashStore((s) => s.restoring)
  const mysqlConnections = connections.filter((c) => c.kind === "mysql")
  const original = mysqlConnections.some((c) => c.id === entry.connectionId)
  // Without the original connection the user picks one; nothing is preselected.
  const [target, setTarget] = useState(original ? entry.connectionId : "")
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const [rowSelection, setRowSelection] = useState<RowSelection>(EMPTY_ROW_SELECTION)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const columns = useMemo(() => trashColumns(entry), [entry])
  const rows = useMemo(() => displayRows(entry.rows, columns.length, EMPTY_EDITS), [entry, columns])
  const updateRows = useCallback(
    (update: (current: RowSelection) => RowSelection) =>
      setRowSelection((current) => update(current)),
    [],
  )
  const selected = rowSelection.rows.size
  const blocked = !target || entry.status === "pending" || restoring

  const restore = async (selectedOnly: boolean) => {
    const options = restoreOptions(entry, selectedOnly ? rowSelection.rows : null, target)
    if (!target || !options) return
    // Connects first when needed (asking for a password when none is stored).
    if ((await ensureMysqlSession(target)) !== "ready") return
    // The panel or the open entry may have changed while connecting.
    if (!useUiStore.getState().trashOpen || useTrashStore.getState().selectedId !== entry.id) return
    const name = connections.find((c) => c.id === target)?.name ?? target
    useTrashStore.getState().requestRestore(entry.id, options, restoreCount(entry, options), {
      connectionName: name,
      otherConnection: target !== entry.connectionId,
    })
  }

  return (
    <div className="trash-detail">
      <div className="trash-detail__head">
        <strong>
          {entry.database}.{entry.table}
        </strong>
        <span className="trash-item__meta">
          {formatDeletedAt(entry.deletedAt)} · {entry.connectionName} ·{" "}
          {summaryLine({ rowCount: entry.rows.length, source: entry.source })}
        </span>
        {statusNote(entry.status) && (
          <p className="trash__warning" role="note">
            {statusNote(entry.status)}
          </p>
        )}
        {entry.statement && (
          <details className="trash-detail__statement">
            <summary>Statement</summary>
            <pre>{entry.statement}</pre>
          </details>
        )}
      </div>
      <div className="trash-detail__grid">
        <ResultGrid
          columns={columns}
          sourceRows={entry.rows}
          rows={rows}
          editable={false}
          selection={selection}
          onSelect={setSelection}
          widthKey={`trash:${entry.id}`}
          rowSelection={rowSelection}
          onRowSelectionChange={updateRows}
        />
      </div>
      <div className="trash-detail__actions">
        <label className="trash-detail__target">
          <span>Restore to</span>
          <select
            className="ui-input trash-select"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            aria-label="Connection to restore to"
          >
            {!original && <option value="">Pick a MySQL connection</option>}
            {mysqlConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.id === entry.connectionId ? " (original)" : ""}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="sm" disabled={blocked} onClick={() => void restore(false)}>
          {restoring ? "Restoring…" : "Restore all"}
        </Button>
        <Button size="sm" disabled={blocked || selected === 0} onClick={() => void restore(true)}>
          Restore selected{selected > 0 ? ` (${selected})` : ""}
        </Button>
        <span className="trash__spacer" />
        <Button
          variant="danger"
          size="sm"
          disabled={entry.status === "pending" || restoring}
          onClick={() => setConfirmDelete(true)}
        >
          Delete permanently
        </Button>
      </div>
      {confirmDelete && (
        <ConfirmDeleteDialog
          entry={entry}
          onClose={() => setConfirmDelete(false)}
          onError={(message) =>
            showToast({ tone: "error", message: "Couldn't delete", detail: message })
          }
        />
      )}
    </div>
  )
}
