/**
 * Narrow views of tabs for components that subscribe with a shallow comparison, so a keystroke
 * in the SQL editor doesn't re-render the tab bar or the results panel.
 */
import { isWorkspaceTabDirty, type QueryTab, type TabsState, type WorkspaceTab } from "./queryTabs"

/** What one tab bar item shows. */
export interface TabSummary {
  id: string
  kind: WorkspaceTab["kind"]
  title: string
  /** Tooltip name: a table tab shows where its table lives. */
  longName: string
  connectionId: string
  dirty: boolean
}

export function tabSummary(tab: WorkspaceTab): TabSummary {
  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    longName: tab.kind === "table" ? `${tab.database}.${tab.table}` : tab.title,
    connectionId: tab.connectionId,
    dirty: isWorkspaceTabDirty(tab),
  }
}

/** Summary of the tab with `id`, or null once it closed. */
export function selectTabSummary(state: TabsState, id: string): TabSummary | null {
  const tab = state.tabs.find((t) => t.id === id)
  return tab ? tabSummary(tab) : null
}

/** Everything the results panel reads from a query tab; the editor text is left out. */
export type ResultsView = Pick<
  QueryTab,
  | "id"
  | "connectionId"
  | "results"
  | "activeResult"
  | "running"
  | "error"
  | "edits"
  | "applying"
  | "runId"
  | "ranDatabase"
>

export function selectResultsView(state: TabsState, id: string): ResultsView | null {
  const tab = state.tabs.find((t): t is QueryTab => t.id === id && t.kind === "query")
  if (!tab) return null
  const { connectionId, results, activeResult, running, error, edits, applying, runId } = tab
  return {
    id,
    connectionId,
    results,
    activeResult,
    running,
    error,
    edits,
    applying,
    runId,
    ranDatabase: tab.ranDatabase,
  }
}
