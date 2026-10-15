import type { QueryResult } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import { useTabsStore } from "../../state/tabsStore"
import type { MysqlSession } from "../../state/sessionsStore"
import { editTargetFor } from "./editing"
import { ErrorPanel } from "./ErrorPanel"
import { ResultMeta } from "./ResultMeta"
import { RowsView } from "./RowsView"

interface ResultsPanelProps {
  tab: QueryTab
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

  if (tab.error) {
    return (
      <section className="results">
        <ErrorPanel error={tab.error} />
      </section>
    )
  }
  if (!result) {
    return (
      <section className="results">
        <div className="results__empty">
          {tab.running ? "Running…" : "Run a query to see results here."}
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
          key={tab.activeResult}
          tab={tab}
          index={tab.activeResult}
          result={result}
          edit={editTargetFor(tab, result, session)}
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
