import type { EditorView } from "@codemirror/view"
import { Play, Square } from "lucide-react"
import { useCallback, useState } from "react"
import { SqlEditor } from "../../components/editor/lazyEditors"
import type { SchemaSnapshot } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import { dialectFor } from "../../lib/sqlDialect"
import { formatShortcut } from "../../lib/shortcuts"
import { useAthenaStore } from "../../state/athenaStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { cancelActiveRun, runActiveTab } from "./actions"
import { APP_SHORTCUTS, handleAppShortcut } from "./appShortcuts"
import { useCompletionSources } from "./completion"
import { DatabaseSwitcher } from "./DatabaseSwitcher"
import { athenaTabDatabase, tabDatabase } from "./editing"
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
  const athena = tab.engine === "athena"
  const mysqlDatabase = useSessionsStore((s) => tabDatabase(tab, s.sessions[connectionId]))
  const athenaDatabase = useAthenaStore((s) => athenaTabDatabase(tab, s.catalogs[connectionId]))
  const database = athena ? athenaDatabase : mysqlDatabase
  const completionSources = useCompletionSources(connectionId, database, tab.engine)

  const onChange = useCallback((sql: string) => setSql(tabId, sql), [setSql, tabId])
  const onViewChange = useCallback(
    (view: EditorView | null) => registerEditor(tabId, view),
    [tabId],
  )
  const onKeyDownCapture = useCallback((event: KeyboardEvent, view: EditorView) => {
    const main = view.state.selection.main
    return handleAppShortcut(event, {
      cursor: main.head,
      selectedText: view.state.sliceDoc(main.from, main.to),
    })
  }, [])
  // Only whether something is selected: the label of the second button depends on it.
  const [hasSelection, setHasSelection] = useState(false)
  const onSelectionChange = useCallback(
    (view: EditorView) => setHasSelection(!view.state.selection.main.empty),
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
          dialect={dialectFor(tab.engine).editor}
          placeholderText={`Write SQL. ${formatShortcut(APP_SHORTCUTS.runStatement)} runs the statement at the cursor, ${formatShortcut(APP_SHORTCUTS.runSelection)} runs the selection or everything.`}
          onKeyDownCapture={onKeyDownCapture}
          onSelectionChange={onSelectionChange}
          onViewChange={onViewChange}
          autoFocus
        />
      </div>
      <div className="editor-pane__bar">
        <button
          type="button"
          className="q-button q-button--primary"
          onClick={() => void runActiveTab("statement")}
          disabled={tab.running}
          title="Run the statement at the cursor"
        >
          <Play size={12} strokeWidth={2.4} />
          Run
          <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.runStatement)}</kbd>
        </button>
        <button
          type="button"
          className="q-button"
          onClick={() => void runActiveTab("selection")}
          disabled={tab.running}
          title={hasSelection ? "Run the selected text" : "Run everything in the editor"}
        >
          {hasSelection ? "Run selection" : "Run all"}
          <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.runSelection)}</kbd>
        </button>
        {athena && tab.running && (
          <button
            type="button"
            className="q-button"
            onClick={() => void cancelActiveRun()}
            title="Stop the running Athena query; later statements don't start"
          >
            <Square size={11} strokeWidth={2.4} />
            Cancel
          </button>
        )}
        <span className="editor-pane__spacer" />
        {tab.running && <span className="editor-pane__status">Running…</span>}
        <DatabaseSwitcher tab={tab} />
      </div>
      <div className="run-line" data-running={tab.running || undefined} aria-hidden="true" />
    </div>
  )
}
