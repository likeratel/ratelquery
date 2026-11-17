import { Button, Dialog } from "../../components/ui"
import type { BackupStoppedResult, DeletePlanEntry } from "../../lib/mysql"
import { statementNumber, statementPreview } from "../../lib/sqlTrash"
import { answerDeleteBackup, useDeleteBackupStore } from "./deleteBackupConfirm"
import "./runGuard.css"

const cancel = () => answerDeleteBackup(false)

/** One line of the statement; a longer one opens to show all of it. */
function StatementText({ statement }: { statement: string }) {
  const preview = statementPreview(statement)
  if (preview === statement.trim()) return <code className="run-confirm__sql">{preview}</code>
  return (
    <details>
      <summary>
        <code>{preview}</code>
      </summary>
      <code className="run-confirm__sql">{statement}</code>
    </details>
  )
}
const confirm = () => answerDeleteBackup(true)

/** The questions about DELETE statements that can't be backed up. Mounted once in the shell. */
export function DeleteBackupDialog() {
  const pending = useDeleteBackupStore((s) => s.pending)
  if (!pending) return null
  return pending.kind === "unsupported" ? (
    <UnsupportedDialog key={pending.id} entries={pending.entries} />
  ) : (
    <StoppedDialog key={pending.id} stop={pending.stop} />
  )
}

function UnsupportedDialog({ entries }: { entries: readonly DeletePlanEntry[] }) {
  const count = entries.length
  return (
    <Dialog
      title={
        count === 1 ? "Run a DELETE without a backup?" : `Run ${count} DELETEs without a backup?`
      }
      description="Their rows can't be saved to the Trash first, so they couldn't be restored. Nothing runs unless you choose to."
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm}>
            {count === 1 ? "Run without backup" : "Run without backup for these"}
          </Button>
        </>
      }
    >
      <ul className="run-confirm__list">
        {entries.map((entry) => (
          <li key={entry.index} className="run-confirm__item">
            <span>Statement {statementNumber(entry.index)}</span>
            <StatementText statement={entry.statement} />
            <span className="run-confirm__reason">{entry.reason}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

function StoppedDialog({ stop }: { stop: BackupStoppedResult }) {
  const number = statementNumber(stop.statementIndex)
  return (
    <Dialog
      title="Delete without a backup?"
      description={`Statement ${number} couldn't be backed up: ${stop.reason}. It did not run.`}
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
      <ul className="run-confirm__list">
        <li className="run-confirm__item">
          <StatementText statement={stop.statement} />
          <span className="run-confirm__reason">
            {number > 1
              ? `Statements before it already ran and won't run again; statement ${number} and the rest run next.`
              : "It and the rest of the script run next."}
          </span>
        </li>
      </ul>
    </Dialog>
  )
}
