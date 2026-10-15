import type { ConnectionId } from "./connections"
import type { GridEdits } from "./gridEdits"
import { pendingCount } from "./gridEdits"
import type { AppError } from "./ipc"
import type { QueryResult } from "./mysql"

export interface QueryTab {
  id: string
  connectionId: ConnectionId
  title: string
  sql: string
  /** Database the tab's queries run against; null uses the session default. */
  database: string | null
  results: readonly QueryResult[]
  activeResult: number
  running: boolean
  error: AppError | null
  /** Pending grid edits keyed by result index. */
  edits: Readonly<Record<number, GridEdits>>
  /** Increments on every finished run; drives stale-response checks and count-up animation. */
  runId: number
  /** SQL that last ran (whole script or the single statement). */
  lastRunSql: string | null
  /** Editor text when the last run started; compared to `sql` for the dirty marker. */
  sqlAtRun: string | null
  lastElapsedMs: number | null
}

export interface TabsState {
  tabs: readonly QueryTab[]
  activeId: string | null
  /** Monotonic counter used for "Query N" titles. */
  seq: number
}

export const INITIAL_TABS: TabsState = { tabs: [], activeId: null, seq: 0 }

export function createTab(
  id: string,
  connectionId: ConnectionId,
  title: string,
  database: string | null,
): QueryTab {
  return {
    id,
    connectionId,
    title,
    sql: "",
    database,
    results: [],
    activeResult: 0,
    running: false,
    error: null,
    edits: {},
    runId: 0,
    lastRunSql: null,
    sqlAtRun: null,
    lastElapsedMs: null,
  }
}

/** Appends a tab titled "Query N" and activates it. */
export function openTab(
  state: TabsState,
  params: { id: string; connectionId: ConnectionId; database: string | null },
): TabsState {
  const seq = state.seq + 1
  const tab = createTab(params.id, params.connectionId, `Query ${seq}`, params.database)
  return { tabs: [...state.tabs, tab], activeId: tab.id, seq }
}

/** Removes a tab; when it was active, the right neighbour (or else the left) becomes active. */
export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index === -1) return state
  const tabs = state.tabs.filter((t) => t.id !== id)
  if (state.activeId !== id) return { ...state, tabs }
  const neighbour = tabs[index] ?? tabs[index - 1] ?? null
  return { ...state, tabs, activeId: neighbour ? neighbour.id : null }
}

export function activateTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state
}

export function updateTab(
  state: TabsState,
  id: string,
  update: (tab: QueryTab) => QueryTab,
): TabsState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? update(t) : t)) }
}

export function startRun(tab: QueryTab): QueryTab {
  return { ...tab, running: true, error: null, sqlAtRun: tab.sql }
}

/** Index of the last rows result, so a script ending in SELECT lands on its rows. */
export function preferredResultIndex(results: readonly QueryResult[]): number {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (results[i].kind === "rows") return i
  }
  return Math.max(0, results.length - 1)
}

export function finishRun(tab: QueryTab, sql: string, results: readonly QueryResult[]): QueryTab {
  return {
    ...tab,
    running: false,
    error: null,
    results,
    activeResult: preferredResultIndex(results),
    edits: {},
    runId: tab.runId + 1,
    lastRunSql: sql,
    lastElapsedMs: results.reduce((sum, r) => sum + r.elapsedMs, 0),
  }
}

export function failRun(tab: QueryTab, sql: string, error: AppError): QueryTab {
  return { ...tab, running: false, error, runId: tab.runId + 1, lastRunSql: sql }
}

/** Replaces one result after edits were applied and its statement re-ran. */
export function replaceResult(tab: QueryTab, index: number, result: QueryResult): QueryTab {
  const { [index]: _applied, ...edits } = tab.edits
  return {
    ...tab,
    results: tab.results.map((r, i) => (i === index ? result : r)),
    edits,
    runId: tab.runId + 1,
    lastElapsedMs: result.elapsedMs,
  }
}

export function setTabEdits(tab: QueryTab, index: number, edits: GridEdits): QueryTab {
  return { ...tab, edits: { ...tab.edits, [index]: edits } }
}

export function tabPendingCount(tab: QueryTab): number {
  return Object.values(tab.edits).reduce((sum, edits) => sum + pendingCount(edits), 0)
}

/** True when the tab has pending grid edits or SQL that differs from what last ran. */
export function isTabDirty(tab: QueryTab): boolean {
  if (tabPendingCount(tab) > 0) return true
  return tab.sql.trim() !== "" && tab.sql !== (tab.sqlAtRun ?? "")
}
