import { ChevronRight, Copy, CornerDownLeft } from "lucide-react"
import { memo, useMemo, useState } from "react"
import { copyToClipboard } from "../../components/grid/clipboard"
import { SegmentedControl, type SegmentOption } from "../../components/ui"
import { formatElapsed } from "../../lib/cellFormat"
import type { ConnectionId } from "../../lib/connections"
import {
  entryStatus,
  formatEntryTime,
  outcomeText,
  sqlOneLine,
  visibleEntries,
  type OutputEntry,
  type OutputScope,
} from "../../lib/queryOutput"
import { useQueryOutputStore } from "../../state/queryOutputStore"
import { insertSqlIntoEditor } from "./actions"

const SCOPE_OPTIONS: readonly SegmentOption<OutputScope>[] = [
  { value: "tab", label: "This tab" },
  { value: "connection", label: "All on this connection" },
]

const NO_ENTRIES: readonly OutputEntry[] = []

interface OutputRowProps {
  entry: OutputEntry
  tabId: string
  now: number
}

/** One logged statement: collapsed to a line until its statement is clicked. */
const OutputRow = memo(function OutputRow({ entry, tabId, now }: OutputRowProps) {
  const [expanded, setExpanded] = useState(false)
  const status = entryStatus(entry.outcome)
  const outcome = outcomeText(entry.outcome)
  return (
    <li className="output-entry" data-status={status}>
      <span className="output-entry__dot" aria-hidden="true" />
      <time
        className="output-entry__time"
        dateTime={new Date(entry.at).toISOString()}
        title={new Date(entry.at).toLocaleString()}
      >
        {formatEntryTime(entry.at, now)}
      </time>
      <div className="output-entry__body">
        <button
          type="button"
          className="output-entry__toggle"
          aria-expanded={expanded}
          title={expanded ? "Collapse the statement" : "Show the full statement"}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronRight size={12} className="output-entry__chevron" aria-hidden="true" />
          <span className="output-entry__line">{sqlOneLine(entry.sql)}</span>
        </button>
        {expanded && (
          <pre className="output-entry__sql">
            {entry.sql}
            {entry.sqlTruncated && <span className="output-entry__cut">{"\n"}… (cut)</span>}
          </pre>
        )}
        <div className="output-entry__outcome">{outcome}</div>
      </div>
      <span className="output-entry__elapsed">
        {entry.elapsedMs === null ? "" : formatElapsed(entry.elapsedMs)}
      </span>
      <div className="output-entry__actions">
        <button
          type="button"
          className="q-button q-button--ghost"
          title="Insert into editor"
          aria-label="Insert into editor"
          onClick={() => insertSqlIntoEditor(tabId, entry.sql)}
        >
          <CornerDownLeft size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="q-button q-button--ghost"
          title="Copy SQL"
          aria-label="Copy SQL"
          onClick={() => copyToClipboard(entry.sql)}
        >
          <Copy size={13} aria-hidden="true" />
        </button>
      </div>
    </li>
  )
})

interface OutputViewProps {
  tabId: string
  connectionId: ConnectionId
}

/** The Output log of a query tab: what the database returned for each run, newest first. */
export function OutputView({ tabId, connectionId }: OutputViewProps) {
  const scope = useQueryOutputStore((s) => s.scope)
  const setScope = useQueryOutputStore((s) => s.setScope)
  const entries = useQueryOutputStore((s) => s.log[connectionId] ?? NO_ENTRIES)
  const visible = useMemo(
    () => visibleEntries({ [connectionId]: entries }, { connectionId, tabId, scope }),
    [entries, connectionId, tabId, scope],
  )
  // Only the day matters (it decides how much of the date is shown), so rows stay memoized.
  const today = new Date().setHours(0, 0, 0, 0)
  return (
    <div className="output-view">
      <div className="result-toolbar">
        <SegmentedControl
          label="Show output from"
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={setScope}
        />
        <span className="result-toolbar__spacer" />
        <span className="result-meta__muted output-view__count">
          {visible.length.toLocaleString("en-US")} {visible.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      {visible.length === 0 ? (
        <div className="results__empty">
          {scope === "tab"
            ? "Statements run in this tab are listed here"
            : "Statements run on this connection are listed here"}
        </div>
      ) : (
        <ol className="output-log" aria-label="Query output">
          {visible.map((entry) => (
            <OutputRow key={entry.id} entry={entry} tabId={tabId} now={today} />
          ))}
        </ol>
      )}
    </div>
  )
}
