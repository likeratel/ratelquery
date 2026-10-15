import { Button, Dialog } from "../../components/ui"
import { answerDangerousRun, useRunGuardStore } from "./runGuard"
import "./runGuard.css"

const cancel = () => answerDangerousRun(false)

/** Asks before running statements flagged by `classifyDanger`. Mounted once in the shell. */
export function RunConfirmDialog() {
  const dangers = useRunGuardStore((s) => s.confirm?.dangers ?? null)
  if (!dangers) return null
  const count = dangers.length
  return (
    <Dialog
      title={count === 1 ? "Run a destructive statement?" : `Run ${count} destructive statements?`}
      description="These can't be undone. Turn this check off in Settings."
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => answerDangerousRun(true)}>
            Run anyway
          </Button>
        </>
      }
    >
      <ul className="run-confirm__list">
        {dangers.map((danger, index) => (
          <li key={index} className="run-confirm__item">
            <code className="run-confirm__sql">{danger.statement}</code>
            <span className="run-confirm__reason">{danger.reason}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
