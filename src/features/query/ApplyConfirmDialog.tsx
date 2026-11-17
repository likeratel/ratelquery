import { copyToClipboard } from "../../components/grid/clipboard"
import { Button, Dialog } from "../../components/ui"
import {
  canConfirmApply,
  describeCounts,
  previewSlice,
  previewWarningNote,
  rowsLabel,
  trashNote,
} from "../../lib/applyPlan"
import {
  answerApplyConfirm,
  useApplyConfirmStore,
  type ApplyRequest,
  type BackupFailedRequest,
  type PreviewState,
} from "./applyConfirm"
import "./applyConfirm.css"

const cancel = () => answerApplyConfirm(false)
const confirm = () => answerApplyConfirm(true)

/** The apply and "delete without backup" confirmations. Mounted once in the shell. */
export function ApplyConfirmDialog() {
  const pending = useApplyConfirmStore((s) => s.pending)
  if (!pending) return null
  return pending.kind === "apply" ? (
    <ApplyDialog key={pending.id} request={pending.request} preview={pending.preview} />
  ) : (
    <BackupFailedDialog key={pending.id} request={pending.request} />
  )
}

function ApplyDialog({ request, preview }: { request: ApplyRequest; preview: PreviewState }) {
  const { counts } = request
  const deletes = counts.deletes > 0
  return (
    <Dialog
      title={`Apply changes to ${request.table}?`}
      description={describeCounts(counts)}
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} autoFocus>
            Cancel
          </Button>
          <Button
            variant={deletes ? "danger" : "primary"}
            onClick={confirm}
            disabled={!canConfirmApply(preview)}
          >
            Apply
          </Button>
        </>
      }
    >
      {deletes && (
        <p className="apply-confirm__note">{trashNote(counts.deletes, request.retentionDays)}</p>
      )}
      <SqlPreview preview={preview} deletes={counts.deletes} />
    </Dialog>
  )
}

function SqlPreview({ preview, deletes }: { preview: PreviewState; deletes: number }) {
  if (preview.status === "loading") {
    return <p className="apply-confirm__status">Loading the SQL preview…</p>
  }
  if (preview.status === "error") {
    return (
      <p className="apply-confirm__status apply-confirm__status--warning">
        SQL preview unavailable: {preview.message}
      </p>
    )
  }
  if (preview.warning) {
    const note = previewWarningNote(deletes)
    return (
      <p className="apply-confirm__status apply-confirm__status--warning">
        {preview.warning}
        {note && ` ${note}`}
      </p>
    )
  }
  const { shown, hidden } = previewSlice(preview.statements)
  return (
    <div className="apply-confirm__preview">
      <div className="apply-confirm__preview-head">
        <span>SQL to run</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => copyToClipboard(preview.statements.map((s) => `${s};`).join("\n"))}
        >
          Copy
        </Button>
      </div>
      <pre className="apply-confirm__sql" tabIndex={0} aria-label="SQL to run">
        {shown.map((statement) => `${statement};`).join("\n")}
      </pre>
      {hidden > 0 && (
        <p className="apply-confirm__status">
          and {hidden.toLocaleString("en-US")} more (Copy includes all)
        </p>
      )}
    </div>
  )
}

function BackupFailedDialog({ request }: { request: BackupFailedRequest }) {
  return (
    <Dialog
      title="Delete without a backup?"
      description={`The ${rowsLabel(request.deletes)} to delete from ${request.table} couldn't be saved to the Trash. Nothing was changed.`}
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm}>
            Delete without backup
          </Button>
        </>
      }
    >
      <p className="apply-confirm__status apply-confirm__status--warning">{request.message}</p>
      <p className="apply-confirm__note">
        Deleted rows can't be restored from the Trash if you go ahead.
      </p>
    </Dialog>
  )
}
