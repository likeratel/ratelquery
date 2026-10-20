import type { ConnectionId } from "./connections"
import { createDynamoTab, isDynamoTabDirty, type DynamoTab } from "./dynamoTabs"
import type { GridEdits } from "./gridEdits"
import { pendingCount } from "./gridEdits"
import type { AppError } from "./ipc"
import type { QueryResult, TableDetails } from "./mysql"
import {
  forgetRecent,
  insertTab,
  nextActiveAfterClose,
  rememberActive,
  type RecentTabs,
} from "./tabGroups"

/** What runs a query tab's SQL: a MySQL session, or Athena query executions. */
export type QueryEngine = "mysql" | "athena"

export interface QueryTab {
  kind: "query"
  id: string
  connectionId: ConnectionId
  /** Fixed when the tab opens; a connection's kind never changes. */
  engine: QueryEngine
  title: string
  sql: string
  /** Database the tab's queries run against; null uses the session default. */
  database: string | null
  /**
   * Database the current results came from, resolved when the run started. Editing, applying
   * and full exports use it, so changing the database afterwards can't retarget them.
   */
  ranDatabase: string | null
  results: readonly QueryResult[]
  activeResult: number
  running: boolean
  error: AppError | null
  /** Pending grid edits keyed by result index. */
  edits: Readonly<Record<number, GridEdits>>
  /** True while a batch of edits is being sent, so a second Apply can't send it again. */
  applying: boolean
  /** Increments on every finished run; drives stale-response checks and count-up animation. */
  runId: number
  /** SQL that last ran (whole script or the single statement). */
  lastRunSql: string | null
  /** Editor text when the last run started; compared to `sql` for the dirty marker. */
  sqlAtRun: string | null
  lastElapsedMs: number | null
  /** Athena execution running right now, so it can be cancelled; always null for MySQL. */
  executionId: string | null
}

/** Structure of one MySQL table or view: columns, indexes, foreign keys and DDL. */
export interface TableTab {
  kind: "table"
  id: string
  connectionId: ConnectionId
  /** The table name. */
  title: string
  database: string
  table: string
  /** Last `mysql_table_details` response; kept until the user refreshes. */
  details: TableDetails | null
  loading: boolean
  error: AppError | null
  /** Increments on every request so a late response can't overwrite a newer one. */
  requestId: number
}

/** Every tab in the tab bar; `kind` picks the screen that renders it. */
export type WorkspaceTab = QueryTab | DynamoTab | TableTab

export interface TabsState {
  tabs: readonly WorkspaceTab[]
  activeId: string | null
  /** Monotonic counter used for "Query N" titles. */
  seq: number
  /** Tab whose close waits for confirmation because it holds unsaved work. */
  closing: string | null
  /** Connection whose tabs wait to close together because some of them hold unsaved work. */
  closingGroup: ConnectionId | null
  /** Last active tab per connection (see `rememberActive`). */
  recent: RecentTabs
}

export const INITIAL_TABS: TabsState = {
  tabs: [],
  activeId: null,
  seq: 0,
  closing: null,
  closingGroup: null,
  recent: {},
}

export function createTab(
  id: string,
  connectionId: ConnectionId,
  title: string,
  database: string | null,
  engine: QueryEngine = "mysql",
): QueryTab {
  return {
    kind: "query",
    id,
    connectionId,
    engine,
    title,
    sql: "",
    database,
    ranDatabase: null,
    results: [],
    activeResult: 0,
    running: false,
    error: null,
    edits: {},
    applying: false,
    runId: 0,
    lastRunSql: null,
    sqlAtRun: null,
    lastElapsedMs: null,
    executionId: null,
  }
}

/** Adds a tab titled "Query N" after its connection's tabs and activates it. */
export function openTab(
  state: TabsState,
  params: {
    id: string
    connectionId: ConnectionId
    database: string | null
    engine?: QueryEngine
  },
): TabsState {
  const seq = state.seq + 1
  const tab = createTab(
    params.id,
    params.connectionId,
    `Query ${seq}`,
    params.database,
    params.engine,
  )
  return rememberActive({ ...state, tabs: insertTab(state.tabs, tab), activeId: tab.id, seq })
}

/** Adds a DynamoDB tab titled "DynamoDB N" after its connection's tabs and activates it. */
export function openDynamoTab(
  state: TabsState,
  params: { id: string; connectionId: ConnectionId },
): TabsState {
  const seq = state.seq + 1
  const tab = createDynamoTab(params.id, params.connectionId, `DynamoDB ${seq}`)
  return rememberActive({ ...state, tabs: insertTab(state.tabs, tab), activeId: tab.id, seq })
}

export function createTableTab(
  id: string,
  connectionId: ConnectionId,
  database: string,
  table: string,
): TableTab {
  return {
    kind: "table",
    id,
    connectionId,
    title: table,
    database,
    table,
    details: null,
    loading: false,
    error: null,
    requestId: 0,
  }
}

/** The open table tab for `table` in `database` on `connectionId`, if any. */
export function findTableTab(
  state: TabsState,
  params: { connectionId: ConnectionId; database: string; table: string },
): TableTab | null {
  const found = state.tabs.find(
    (t) =>
      t.kind === "table" &&
      t.connectionId === params.connectionId &&
      t.database === params.database &&
      t.table === params.table,
  )
  return found?.kind === "table" ? found : null
}

/**
 * Activates the table's tab when it is already open, otherwise adds one after its connection's
 * tabs and activates it.
 */
export function openTableTab(
  state: TabsState,
  params: { id: string; connectionId: ConnectionId; database: string; table: string },
): TabsState {
  const existing = findTableTab(state, params)
  if (existing) return rememberActive({ ...state, activeId: existing.id })
  const tab = createTableTab(params.id, params.connectionId, params.database, params.table)
  return rememberActive({ ...state, tabs: insertTab(state.tabs, tab), activeId: tab.id })
}

/** Ids of every tab, of any kind, opened on `connectionId`. */
export function tabsForConnection(state: TabsState, connectionId: ConnectionId): string[] {
  return state.tabs.filter((t) => t.connectionId === connectionId).map((t) => t.id)
}

/**
 * Removes a tab. When it was active, its right neighbour on the same connection (or else the
 * left one) becomes active; closing a connection's last tab moves to a neighbouring connection's
 * remembered tab (see `nextActiveAfterClose`).
 */
export function closeTab(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.id === id)) return state
  const tabs = state.tabs.filter((t) => t.id !== id)
  const closing = state.closing === id ? null : state.closing
  const closingGroup =
    state.closingGroup && tabs.some((t) => t.connectionId === state.closingGroup)
      ? state.closingGroup
      : null
  const recent = forgetRecent(state.recent, id)
  if (state.activeId !== id) return { ...state, tabs, closing, closingGroup, recent }
  const activeId = nextActiveAfterClose(state, id)
  return rememberActive({ ...state, tabs, closing, closingGroup, recent, activeId })
}

/**
 * Closing would lose work: a DynamoDB item editor with unsaved text, or grid edits not yet
 * applied. Unrun SQL alone doesn't count; it only drives the dirty marker.
 */
export function hasUnsavedWork(tab: WorkspaceTab): boolean {
  if (tab.kind === "table") return false
  return tab.kind === "query" ? tabPendingCount(tab) > 0 : isDynamoTabDirty(tab)
}

/** Closes the tab, or asks first (sets `closing`) when it holds unsaved work. */
export function requestCloseTab(state: TabsState, id: string): TabsState {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab) return state
  return hasUnsavedWork(tab) ? { ...state, closing: id } : closeTab(state, id)
}

/** Confirms the pending close. */
export function confirmCloseTab(state: TabsState): TabsState {
  return state.closing ? closeTab(state, state.closing) : state
}

/** Keeps the tab open and dismisses the confirmation. */
export function cancelCloseTab(state: TabsState): TabsState {
  return state.closing ? { ...state, closing: null } : state
}

export function activateTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((t) => t.id === id) ? rememberActive({ ...state, activeId: id }) : state
}

/** Updates a query tab; tabs of another kind are left alone. */
export function updateTab(
  state: TabsState,
  id: string,
  update: (tab: QueryTab) => QueryTab,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id && t.kind === "query" ? update(t) : t)),
  }
}

/** Updates a DynamoDB tab; tabs of another kind are left alone. */
export function updateDynamoTab(
  state: TabsState,
  id: string,
  update: (tab: DynamoTab) => DynamoTab,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id && t.kind === "dynamo" ? update(t) : t)),
  }
}

/** Updates a table tab; tabs of another kind are left alone. */
export function updateTableTab(
  state: TabsState,
  id: string,
  update: (tab: TableTab) => TableTab,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id && t.kind === "table" ? update(t) : t)),
  }
}

/** Marks a details request as started; the previous details stay visible while it runs. */
export function startTableLoad(tab: TableTab): TableTab {
  return { ...tab, loading: true, error: null, requestId: tab.requestId + 1 }
}

/** Stores the details when `requestId` is still the latest request. */
export function finishTableLoad(tab: TableTab, requestId: number, details: TableDetails): TableTab {
  if (tab.requestId !== requestId) return tab
  return { ...tab, loading: false, error: null, details }
}

/** Records a failed request when `requestId` is still the latest request. */
export function failTableLoad(tab: TableTab, requestId: number, error: AppError): TableTab {
  if (tab.requestId !== requestId) return tab
  return { ...tab, loading: false, error }
}

export function startRun(tab: QueryTab): QueryTab {
  return { ...tab, running: true, error: null, sqlAtRun: tab.sql }
}

/**
 * Records the Athena execution running for the run started at `runId`; ignored once that run
 * finished (a late answer must not attach an execution to a newer run).
 */
export function setExecutionId(tab: QueryTab, runId: number, executionId: string | null): QueryTab {
  if (!tab.running || tab.runId !== runId || tab.executionId === executionId) return tab
  return { ...tab, executionId }
}

/** Index of the last rows result, so a script ending in SELECT lands on its rows. */
export function preferredResultIndex(results: readonly QueryResult[]): number {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (results[i].kind === "rows") return i
  }
  return Math.max(0, results.length - 1)
}

/** `ranDatabase` is the database the statement ran against (defaults to the tab's own). */
export function finishRun(
  tab: QueryTab,
  sql: string,
  results: readonly QueryResult[],
  ranDatabase: string | null = tab.database,
): QueryTab {
  return {
    ...tab,
    running: false,
    executionId: null,
    error: null,
    ranDatabase,
    results,
    activeResult: preferredResultIndex(results),
    edits: {},
    runId: tab.runId + 1,
    lastRunSql: sql,
    lastElapsedMs: results.reduce((sum, r) => sum + r.elapsedMs, 0),
  }
}

export function failRun(tab: QueryTab, sql: string, error: AppError): QueryTab {
  return {
    ...tab,
    running: false,
    executionId: null,
    error,
    runId: tab.runId + 1,
    lastRunSql: sql,
  }
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

/** Dirty marker for any tab kind. */
export function isWorkspaceTabDirty(tab: WorkspaceTab): boolean {
  if (tab.kind === "table") return false
  return tab.kind === "query" ? isTabDirty(tab) : isDynamoTabDirty(tab)
}
