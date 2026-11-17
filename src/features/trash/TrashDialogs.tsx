import { Button, Dialog, showToast } from "../../components/ui"
import { previewSlice, rowsLabel } from "../../lib/applyPlan"
import { isAppError } from "../../lib/ipc"
import type { TrashEntry } from "../../lib/trash"
import { restoreDescription, restoreFailedTitle, restoredMessage } from "../../lib/trashView"
import { useTrashStore } from "../../state/trashStore"
import "../query/applyConfirm.css"

const errorDetail = (raw: unknown) => (isAppError(raw) ? raw.message : undefined)

async function runRestore(nonTransactional: boolean | null) {
  try {
    const result = await useTrashStore.getState().confirmRestore()
    if (!result) return
    showToast({
      tone: "success",
      message: restoredMessage(result.restoredRows, result.remainingRows),
    })
    if (result.warning)
      showToast({
        tone: "warning",
        message: "The trash entry wasn't updated",
        detail: result.warning,
      })
  } catch (raw) {
    const kind = isAppError(raw) ? raw.kind : "unknown"
    showToast({
      tone: "error",
      message: restoreFailedTitle(kind, nonTransactional),
      detail: errorDetail(raw),
    })
  }
}

/** Shows the INSERTs a restore runs; Restore waits until they have loaded. */
export function RestoreConfirmDialog() {
  const pending = useTrashStore((s) => s.restore)
  const entry = useTrashStore((s) => s.entry)
  if (!pending) return null
  const cancel = () => useTrashStore.getState().cancelRestore()
  const { preview, target } = pending
  // undefined: unknown (preview loading or failed); null: a transactional table.
  const engine = preview.status === "ready" ? preview.nonTransactionalEngine : undefined
  return (
    <Dialog
      title={`Restore ${rowsLabel(pending.count)}?`}
      description={
        entry ? restoreDescription(`${entry.database}.${entry.table}`, engine) : undefined
      }
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} autoFocus>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={preview.status === "loading"}
            onClick={() => void runRestore(engine === undefined ? null : engine !== null)}
          >
            Restore
          </Button>
        </>
      }
    >
      <p
        className={
          target.otherConnection
            ? "apply-confirm__status apply-confirm__status--warning"
            : "apply-confirm__note"
        }
      >
        Restoring through {target.connectionName}
        {target.otherConnection ? ", not the connection the rows were deleted from." : "."}
      </p>
      {engine && (
        <p className="apply-confirm__status apply-confirm__status--warning">
          The table uses the {engine} engine, which can&apos;t roll back: if a row fails, the rows
          before it stay restored.
        </p>
      )}
      {entry?.status === "uncertain" && (
        <p className="apply-confirm__status apply-confirm__status--warning">
          This delete may not have happened: the rows could still be in the table, and restoring
          them would fail or duplicate them.
        </p>
      )}
      {preview.status === "loading" && (
        <p className="apply-confirm__status">Loading the SQL preview…</p>
      )}
      {preview.status === "error" && (
        <p className="apply-confirm__status apply-confirm__status--warning">
          SQL preview unavailable: {preview.message}
        </p>
      )}
      {preview.status === "ready" && preview.warning && (
        <p className="apply-confirm__status apply-confirm__status--warning">{preview.warning}</p>
      )}
      {preview.status === "ready" && !preview.warning && (
        <StatementList statements={preview.statements} total={preview.total} />
      )}
    </Dialog>
  )
}

/** The statements the backend sent (at most 200) and how many more the restore runs. */
function StatementList({ statements, total }: { statements: readonly string[]; total: number }) {
  const { shown } = previewSlice(statements)
  const hidden = Math.max(0, total - shown.length)
  return (
    <div className="apply-confirm__preview">
      <pre className="apply-confirm__sql" tabIndex={0} aria-label="SQL to run">
        {shown.map((statement) => `${statement};`).join("\n")}
      </pre>
      {hidden > 0 && (
        <p className="apply-confirm__status">and {hidden.toLocaleString("en-US")} more</p>
      )}
    </div>
  )
}

export function ConfirmDeleteDialog({
  entry,
  onClose,
  onError,
}: {
  entry: TrashEntry
  onClose: () => void
  onError: (message: string | undefined) => void
}) {
  const remove = async () => {
    onClose()
    try {
      await useTrashStore.getState().remove(entry.id)
    } catch (raw) {
      onError(errorDetail(raw))
    }
  }
  return (
    <Dialog
      title="Delete permanently?"
      description={`The ${rowsLabel(entry.rows.length)} from ${entry.database}.${entry.table} can't be restored afterwards.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            Delete permanently
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}

export function ConfirmEmptyDialog({ onClose }: { onClose: () => void }) {
  const empty = async () => {
    onClose()
    try {
      const removed = await useTrashStore.getState().empty()
      showToast({
        tone: "success",
        message: `Removed ${removed.toLocaleString("en-US")} ${removed === 1 ? "entry" : "entries"} from the Trash`,
      })
    } catch (raw) {
      showToast({ tone: "error", message: "Couldn't empty the Trash", detail: errorDetail(raw) })
    }
  }
  return (
    <Dialog
      title="Empty the Trash?"
      description="Every saved row is removed for good. Entries of deletes that are still running stay."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void empty()}>
            Empty trash
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
