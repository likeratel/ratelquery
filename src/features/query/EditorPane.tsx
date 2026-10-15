import type { SQLNamespace } from "@codemirror/lang-sql"
import type { EditorView } from "@codemirror/view"
import { Play } from "lucide-react"
import { useCallback, useMemo } from "react"
import { SqlEditor } from "../../components/editor/SqlEditor"
import type { SchemaSnapshot } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import { formatShortcut } from "../../lib/shortcuts"
import { useTabsStore } from "../../state/tabsStore"
import { runActiveTab } from "./actions"
import { APP_SHORTCUTS, handleAppShortcut } from "./appShortcuts"
import { registerEditor } from "./editorRegistry"

/** Completion namespace: table name to column names for the tab's database. */
export function schemaNamespace(schema: SchemaSnapshot | null): SQLNamespace | undefined {
  if (!schema) return undefined
  return Object.fromEntries(schema.tables.map((t) => [t.name, t.columns.map((c) => c.name)]))
}

interface EditorPaneProps {
  tab: QueryTab
  schema: SchemaSnapshot | null
}

export function EditorPane({ tab, schema }: EditorPaneProps) {
  const setSql = useTabsStore((s) => s.setSql)
  const namespace = useMemo(() => schemaNamespace(schema), [schema])
  const tabId = tab.id

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
          schema={namespace}
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
      </div>
      <div className="run-line" data-running={tab.running || undefined} aria-hidden="true" />
    </div>
  )
}
