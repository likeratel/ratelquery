import { useMemo } from "react"
import type { QueryResult } from "../../lib/mysql"
import type { ResultsView } from "../../lib/tabViews"
import { useTabsStore } from "../../state/tabsStore"
import type { MysqlSession } from "../../state/sessionsStore"
import { editTargetFor } from "./editing"
import { ErrorPanel } from "./ErrorPanel"
import { ResultMeta } from "./ResultMeta"
import { RowsView } from "./RowsView"

interface ResultsPanelProps {
  tab: ResultsView
  session: MysqlSession | undefined
}

function resultLabel(result: QueryResult, index: number): string {
  const verb = result.statement.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const name = verb ? verb[0].toUpperCase() + verb.slice(1) : "Statement"
  return `${index + 1} · ${name}`
}

export function ResultsPanel({ tab, session }: ResultsPanelProps) {
  const setActiveResult = useTabsStore((s) => s.setActiveResult)
  const result = tab.results[tab.activeResult]
  const { ranDatabase, engine } = tab
  const edit = useMemo(
    () => editTargetFor({ ranDatabase, engine }, result, session),
    [ranDatabase, engine, result, session],
  )

  if (tab.error) {
    return (
      <section className="results">
        <ErrorPanel error={tab.error} engine={engine} connectionId={tab.connectionId} />
      </section>
    )
  }
  if (!result) {
    return (
      <section className="results">
        <div className="results__empty">
          {tab.running ? "Running…" : "Run a query to see results here"}
        </div>
      </section>
    )
  }

  return (
    <section className="results">
      {tab.results.length > 1 && (
        <div className="result-tabs" role="tablist" aria-label="Statement results">
          {tab.results.map((r, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === tab.activeResult}
              className="result-tabs__tab"
              title={r.statement}
              onClick={() => setActiveResult(tab.id, i)}
            >
              {resultLabel(r, i)}
            </button>
          ))}
        </div>
      )}
      {result.kind === "rows" ? (
        <RowsView
          // A new run starts with no selection; switching result tabs does too.
          key={`${tab.runId}-${tab.activeResult}`}
          tabId={tab.id}
          connectionId={tab.connectionId}
          runId={tab.runId}
          index={tab.activeResult}
          result={result}
          edit={edit}
          edits={tab.edits[tab.activeResult]}
          applying={tab.applying}
          // Athena has no streaming export, and re-running a statement would be billed again.
          allowFull={engine === "mysql" && tab.results.length === 1}
          database={tab.ranDatabase}
        />
      ) : (
        <div className="rows-view">
          <div className="result-toolbar">
            <ResultMeta result={result} runKey={`${tab.id}:${tab.runId}`} />
          </div>
          <div className="results__exec">
            <pre className="results__statement">{result.statement}</pre>
          </div>
        </div>
      )}
    </section>
  )
}
