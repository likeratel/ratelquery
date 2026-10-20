import { useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import type { QueryTab } from "../../lib/queryTabs"
import { selectResultsView } from "../../lib/tabViews"
import { ensureQueryOutputSync } from "../../state/queryOutputSync"
import { useSessionsStore } from "../../state/sessionsStore"
import { selectActiveQueryTab, useTabsStore } from "../../state/tabsStore"
import { EditorPane } from "./EditorPane"
import { tabDatabase } from "./editing"
import { ResultsPanel } from "./ResultsPanel"
import { SplitPane } from "./SplitPane"
import "./query.css"

const findQueryTab = (tabs: readonly { id: string; kind: string }[], id: string) =>
  tabs.find((t): t is QueryTab => t.id === id && t.kind === "query") ?? null

/** Editor half: re-renders as the SQL changes. */
function EditorSlot({ tabId }: { tabId: string }) {
  const tab = useTabsStore((s) => findQueryTab(s.tabs, tabId))
  const session = useSessionsStore((s) => (tab ? s.sessions[tab.connectionId] : undefined))
  if (!tab) return null
  const database = tabDatabase(tab, session)
  const schema = database ? (session?.schemas[database] ?? null) : null
  return <EditorPane tab={tab} schema={schema} />
}

/** Results half: subscribes to the result fields only, so typing doesn't re-render it. */
function ResultsSlot({ tabId }: { tabId: string }) {
  const view = useTabsStore(useShallow((s) => selectResultsView(s, tabId)))
  const session = useSessionsStore((s) => (view ? s.sessions[view.connectionId] : undefined))
  if (!view) return null
  return <ResultsPanel tab={view} session={session} />
}

/** The active query tab: editor above, results below. */
export function QueryWorkspace() {
  const tabId = useTabsStore((s) => selectActiveQueryTab(s)?.id ?? null)
  // Loads the saved Output log and keeps `query-output.json` up to date from the first query
  // tab shown until the window closes.
  useEffect(() => ensureQueryOutputSync(), [])
  if (!tabId) return null
  return (
    <SplitPane
      key={tabId}
      top={<EditorSlot tabId={tabId} />}
      bottom={<ResultsSlot tabId={tabId} />}
    />
  )
}
