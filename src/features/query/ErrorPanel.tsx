import type { ConnectionId } from "../../lib/connections"
import { athenaErrorHint, errorHint } from "../../lib/errorHints"
import type { AppError } from "../../lib/ipc"
import type { QueryEngine } from "../../lib/queryTabs"
import { useConnectionsStore } from "../../state/connectionsStore"

interface ErrorPanelProps {
  error: AppError
  /** Picks the hint wording; MySQL when omitted. */
  engine?: QueryEngine
  connectionId?: ConnectionId
}

export function ErrorPanel({ error, engine = "mysql", connectionId }: ErrorPanelProps) {
  const authType = useConnectionsStore((s) => {
    const config = s.connections.find((c) => c.id === connectionId)
    return config?.kind === "athena" ? config.auth.type : undefined
  })
  const hint = engine === "athena" ? athenaErrorHint(error.kind, authType) : errorHint(error.kind)
  return (
    <div className="result-error" role="alert">
      <pre className="result-error__message">{error.message}</pre>
      <p className="result-error__hint">{hint}</p>
    </div>
  )
}
