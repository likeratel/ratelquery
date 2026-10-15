import { isAthenaResult, type AthenaStats } from "../../lib/athena"
import { formatDataSize } from "../../lib/athenaRun"
import { formatElapsed } from "../../lib/cellFormat"
import type { QueryResult } from "../../lib/mysql"
import { useCountUp } from "./useCountUp"

interface ResultMetaProps {
  result: QueryResult
  /** Unique per finished run, e.g. `${tabId}:${runId}`; drives the one-time count-up. */
  runKey: string
}

/** Bytes scanned (what Athena bills) and engine time of one execution. */
function AthenaMeta({ stats }: { stats: AthenaStats }) {
  return (
    <>
      <span
        className="result-meta__muted"
        title={`Data scanned by execution ${stats.executionId}; Athena bills by this amount`}
      >
        Scanned {formatDataSize(stats.dataScannedBytes)}
      </span>
      {stats.engineMs !== null && (
        <span className="result-meta__muted" title="Engine execution time reported by Athena">
          Engine {formatElapsed(stats.engineMs)}
        </span>
      )}
    </>
  )
}

/** Row count (or affected rows), elapsed time and status badges for one result. */
export function ResultMeta({ result, runKey }: ResultMetaProps) {
  const count = result.kind === "rows" ? result.rowCount : result.affectedRows
  const shown = useCountUp(count, runKey)
  const noun =
    result.kind === "rows"
      ? count === 1
        ? "row"
        : "rows"
      : count === 1
        ? "row affected"
        : "rows affected"
  return (
    <div className="result-meta">
      <span className="result-meta__count">
        <span className="result-meta__number">{shown.toLocaleString()}</span> {noun}
      </span>
      {result.kind === "rows" && result.truncated && (
        <span
          className="badge"
          title={`Only the first ${result.rows.length.toLocaleString()} rows were kept (Settings › Queries › Max rows)`}
        >
          Limited to {result.rows.length.toLocaleString()}
        </span>
      )}
      {result.kind === "exec" && result.lastInsertId && (
        <span className="result-meta__muted">Last insert id {result.lastInsertId}</span>
      )}
      <span className="result-meta__muted">{formatElapsed(result.elapsedMs)}</span>
      {isAthenaResult(result) && <AthenaMeta stats={result.athena} />}
      {/* Athena never retries, so it never shows a reconnect. */}
      {result.reconnected && !isAthenaResult(result) && (
        <span
          className="badge badge--warn"
          title="The connection dropped and was restored for this query"
        >
          Reconnected
        </span>
      )}
    </div>
  )
}
