import type { EditorView } from "@codemirror/view"
import { Play } from "lucide-react"
import { useCallback } from "react"
import { SqlEditor } from "../../components/editor/lazyEditors"
import type { SchemaSnapshot } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import { formatShortcut } from "../../lib/shortcuts"
import { useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { runActiveTab } from "./actions"
import { APP_SHORTCUTS, handleAppShortcut } from "./appShortcuts"
import { useCompletionSources } from "./completion"
import { DatabaseSwitcher } from "./DatabaseSwitcher"
import { tabDatabase } from "./editing"
import { registerEditor } from "./editorRegistry"

interface EditorPaneProps {
  tab: QueryTab
  /**
   * The tab database's schema. Not read here: completion reads the session's schema cache on
   * each request because it also needs other databases' schemas.
   */
  schema: SchemaSnapshot | null
}

export function EditorPane({ tab }: EditorPaneProps) {
  const setSql = useTabsStore((s) => s.setSql)
  const tabId = tab.id
  const connectionId = tab.connectionId
  const database = useSessionsStore((s) => tabDatabase(tab, s.sessions[connectionId]))
  const completionSources = useCompletionSources(connectionId, database)

  const onChange = useCallback((sql: string) => setSql(tabId, sql), [setSql, tabId])
  const onViewChange = useCallback(
    (view: EditorView | null) => registerEditor(tabId, view),
    [tabId],
  )
  const onKeyDownCapture = useCallback(
    (event: KeyboardEvent, view: EditorView) =>
      handleAppShortcut(event, { cursor: view.state.selection.main.head }),
    [],
  )

  return (
    <div className="editor-pane">
      <div className="editor-pane__editor">
        <SqlEditor
          stateKey={tab.id}
          value={tab.sql}
          onChange={onChange}
          completionSources={completionSources}
          placeholderText={`Write SQL. ${formatShortcut(APP_SHORTCUTS.run)} runs everything, ${formatShortcut(APP_SHORTCUTS.runStatement)} runs the statement at the cursor.`}
          onKeyDownCapture={onKeyDownCapture}
          onViewChange={onViewChange}
          autoFocus
        />
      </div>
      <div className="editor-pane__bar">
        <button
          type="button"
          className="q-button q-button--primary"
          onClick={() => void runActiveTab("all")}
          disabled={tab.running}
        >
          <Play size={12} strokeWidth={2.4} />
          Run
          <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.run)}</kbd>
        </button>
        <button
          type="button"
          className="q-button"
          onClick={() => void runActiveTab("statement")}
          disabled={tab.running}
        >
          Run statement
          <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.runStatement)}</kbd>
        </button>
        <span className="editor-pane__spacer" />
        {tab.running && <span className="editor-pane__status">Running…</span>}
        <DatabaseSwitcher tab={tab} />
      </div>
      <div className="run-line" data-running={tab.running || undefined} aria-hidden="true" />
    </div>
  )
}
