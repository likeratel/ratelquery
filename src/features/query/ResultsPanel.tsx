import { useEffect, useId, useMemo, type KeyboardEvent } from "react"
import type { QueryResult } from "../../lib/mysql"
import type { ResultsView } from "../../lib/tabViews"
import { useQueryOutputStore, type BottomPanel } from "../../state/queryOutputStore"
import { useTabsStore } from "../../state/tabsStore"
import type { MysqlSession } from "../../state/sessionsStore"
import { editTargetFor } from "./editing"
import { ErrorPanel } from "./ErrorPanel"
import { OutputView } from "./OutputView"
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

/** The Results view: the rows grid (per statement), the error, or the statement summary. */
function ResultsContent({ tab, session }: ResultsPanelProps) {
  const setActiveResult = useTabsStore((s) => s.setActiveResult)
  const result = tab.results[tab.activeResult]
  const { ranDatabase, engine } = tab
  const edit = useMemo(
    () => editTargetFor({ ranDatabase, engine }, result, session),
    [ranDatabase, engine, result, session],
  )

  if (tab.error) {
    return <ErrorPanel error={tab.error} engine={engine} connectionId={tab.connectionId} />
  }
  if (!result) {
    return (
      <div className="results__empty">
        {tab.running ? "Running…" : "Run a query to see results here"}
      </div>
    )
  }

  return (
    <>
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
    </>
  )
}

const PANELS: readonly { value: BottomPanel; label: string }[] = [
  { value: "results", label: "Results" },
  { value: "output", label: "Output" },
]

/**
 * Bottom half of a query tab: Results and Output. A run never switches between them; an error
 * logged while Output is hidden marks its tab label until Output is shown. Results stays
 * mounted while Output is shown, so the grid keeps its scroll and selection.
 */
export function ResultsPanel({ tab, session }: ResultsPanelProps) {
  const baseId = useId()
  const panel = useQueryOutputStore((s) => s.panels[tab.id] ?? "results")
  const unseenError = useQueryOutputStore((s) => s.unseenErrors[tab.id] === true)
  const setPanel = useQueryOutputStore((s) => s.setPanel)
  const markSeen = useQueryOutputStore((s) => s.markSeen)

  useEffect(() => {
    if (panel === "output" && unseenError) markSeen(tab.id)
  }, [panel, unseenError, markSeen, tab.id])

  const tabElementId = (value: BottomPanel) => `${baseId}-${value}-tab`
  const panelId = (value: BottomPanel) => `${baseId}-${value}-panel`

  const select = (value: BottomPanel, focus: boolean, list?: HTMLElement) => {
    setPanel(tab.id, value)
    if (focus)
      list?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabElementId(value))}`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = PANELS.findIndex((p) => p.value === panel)
    const target = {
      ArrowRight: (index + 1) % PANELS.length,
      ArrowLeft: (index - 1 + PANELS.length) % PANELS.length,
      Home: 0,
      End: PANELS.length - 1,
    }[event.code]
    if (target === undefined) return
    event.preventDefault()
    select(PANELS[target].value, true, event.currentTarget)
  }

  return (
    <section className="results">
      <div
        className="panel-tabs"
        role="tablist"
        aria-label="Results and output"
        onKeyDown={onKeyDown}
      >
        {PANELS.map(({ value, label }) => {
          const selected = value === panel
          const marked = value === "output" && unseenError && !selected
          return (
            <button
              key={value}
              id={tabElementId(value)}
              type="button"
              role="tab"
              aria-selected={selected}
              // Output is only mounted while it is shown.
              aria-controls={value === "results" || selected ? panelId(value) : undefined}
              tabIndex={selected ? 0 : -1}
              className="panel-tabs__tab"
              onClick={() => select(value, false)}
            >
              {label}
              {marked && <span className="panel-tabs__dot" role="img" aria-label="new error" />}
            </button>
          )
        })}
      </div>
      <div
        id={panelId("results")}
        role="tabpanel"
        aria-labelledby={tabElementId("results")}
        className="results__panel"
        hidden={panel !== "results"}
      >
        <ResultsContent tab={tab} session={session} />
      </div>
      {panel === "output" && (
        <div
          id={panelId("output")}
          role="tabpanel"
          aria-labelledby={tabElementId("output")}
          className="results__panel"
        >
          <OutputView tabId={tab.id} connectionId={tab.connectionId} />
        </div>
      )}
    </section>
  )
}
