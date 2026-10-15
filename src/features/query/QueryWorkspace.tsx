import { useSessionsStore } from "../../state/sessionsStore"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"
import { EditorPane } from "./EditorPane"
import { tabDatabase } from "./editing"
import { ResultsPanel } from "./ResultsPanel"
import { SplitPane } from "./SplitPane"
import "./query.css"

/** The active query tab: editor above, results below. */
export function QueryWorkspace() {
  const tab = useTabsStore(selectActiveTab)
  const session = useSessionsStore((s) => (tab ? s.sessions[tab.connectionId] : undefined))
  if (!tab) return null
  const database = tabDatabase(tab, session)
  const schema = database ? (session?.schemas[database] ?? null) : null
  return (
    <SplitPane
      key={tab.id}
      top={<EditorPane tab={tab} schema={schema} />}
      bottom={<ResultsPanel tab={tab} session={session} />}
    />
  )
}
