import { create } from "zustand"
import type { ConnectionId } from "../lib/connections"
import { buildRowChanges, EMPTY_EDITS, type EditTarget, type GridEdits } from "../lib/gridEdits"
import type { DynamoTab } from "../lib/dynamoTabs"
import { normalizeError } from "../lib/ipc"
import { mysqlApi, type ApplyChangesResult, type QueryResult, type RowChange } from "../lib/mysql"
import {
  activateTab,
  cancelCloseTab,
  closeTab,
  confirmCloseTab,
  failRun,
  finishRun,
  INITIAL_TABS,
  openDynamoTab,
  openTab,
  openTableTab,
  replaceResult,
  requestCloseTab,
  setTabEdits,
  startRun,
  tabPendingCount,
  updateDynamoTab,
  updateTab,
  updateTableTab,
  type QueryTab,
  type TableTab,
  type TabsState,
  type WorkspaceTab,
} from "../lib/queryTabs"
import { useSessionsStore } from "./sessionsStore"
import { currentSettings } from "./settingsStore"

/** Row cap per statement, from Settings › Queries › Max rows (backend default 1000). */
export const maxRows = (): number => currentSettings().query.maxRows

export type RunOutcome = "ran" | "failed" | "empty" | "busy" | "pending-edits"

interface TabsStore extends TabsState {
  open: (connectionId: ConnectionId, database: string | null) => string
  /** Opens a DynamoDB tab; its requests run from the dynamo feature through `updateDynamo`. */
  openDynamo: (connectionId: ConnectionId) => string
  updateDynamo: (id: string, update: (tab: DynamoTab) => DynamoTab) => void
  /**
   * Opens (or activates, when already open) the structure tab of a MySQL table. Returns its id.
   * Details are fetched by the schema feature through `updateTable`.
   */
  openTable: (connectionId: ConnectionId, database: string, table: string) => string
  updateTable: (id: string, update: (tab: TableTab) => TableTab) => void
  /** Closes the tab at once, even with unsaved work. */
  close: (id: string) => void
  /** Closes the tab, or asks first (`closing`) when it holds unsaved work. */
  requestClose: (id: string) => void
  confirmClose: () => void
  cancelClose: () => void
  activate: (id: string) => void
  setSql: (id: string, sql: string) => void
  setActiveResult: (id: string, index: number) => void
  /**
   * Switches the tab's database. Refused (returns false) while edits are pending, because they
   * belong to rows read from the current database.
   */
  setDatabase: (id: string, database: string | null) => boolean
  /** Runs `sql` (the whole editor text when omitted) in the tab. */
  run: (id: string, sql?: string) => Promise<RunOutcome>
  updateEdits: (id: string, index: number, update: (edits: GridEdits) => GridEdits) => void
  discardEdits: (id: string, index: number) => void
  /**
   * Sends pending edits for one result in a single transaction, then re-runs its statement.
   * Returns null without sending anything when there is nothing to apply or an apply is
   * already in flight for the tab.
   */
  applyEdits: (id: string, index: number, target: EditTarget) => Promise<ApplyChangesResult | null>
}

const newId = () => crypto.randomUUID()

export const useTabsStore = create<TabsStore>((set, get) => {
  const findTab = (id: string): QueryTab | undefined =>
    get().tabs.find((t): t is QueryTab => t.id === id && t.kind === "query")
  const patchTab = (id: string, update: (tab: QueryTab) => QueryTab) =>
    set((state) => updateTab(state, id, update))

  const noteReconnects = (connectionId: ConnectionId, results: readonly QueryResult[]) => {
    if (results.some((r) => r.reconnected)) {
      useSessionsStore.getState().markReconnected(connectionId)
    }
  }

  /** Commits one batch, then re-reads the result in the database the edits target. */
  const sendEdits = async (
    id: string,
    connectionId: ConnectionId,
    index: number,
    target: EditTarget,
    statement: string,
    changes: RowChange[],
  ): Promise<ApplyChangesResult> => {
    const applied = await mysqlApi.applyChanges(
      connectionId,
      target.database,
      target.table,
      changes,
    )
    const options = { maxRows: maxRows(), database: target.database }
    try {
      const [rerun] = await mysqlApi.query(connectionId, statement, options)
      if (rerun) {
        patchTab(id, (t) => replaceResult(t, index, rerun))
        noteReconnects(connectionId, [rerun])
      }
    } catch (raw) {
      // Changes are committed; only the refresh failed. Clear the edits and surface the error.
      patchTab(id, (t) => ({ ...setTabEdits(t, index, EMPTY_EDITS), error: normalizeError(raw) }))
    }
    return applied
  }

  return {
    ...INITIAL_TABS,

    open: (connectionId, database) => {
      const id = newId()
      set((state) => openTab(state, { id, connectionId, database }))
      return id
    },

    openDynamo: (connectionId) => {
      const id = newId()
      set((state) => openDynamoTab(state, { id, connectionId }))
      return id
    },

    updateDynamo: (id, update) => set((state) => updateDynamoTab(state, id, update)),

    openTable: (connectionId, database, table) => {
      const id = newId()
      set((state) => openTableTab(state, { id, connectionId, database, table }))
      return get().activeId ?? id
    },

    updateTable: (id, update) => set((state) => updateTableTab(state, id, update)),

    close: (id) => set((state) => closeTab(state, id)),

    requestClose: (id) => set((state) => requestCloseTab(state, id)),

    confirmClose: () => set((state) => confirmCloseTab(state)),

    cancelClose: () => set((state) => cancelCloseTab(state)),

    activate: (id) => set((state) => activateTab(state, id)),

    setSql: (id, sql) => patchTab(id, (tab) => ({ ...tab, sql })),

    setActiveResult: (id, index) => patchTab(id, (tab) => ({ ...tab, activeResult: index })),

    setDatabase: (id, database) => {
      const tab = findTab(id)
      if (!tab) return false
      if (tab.database === database) return true
      if (tab.applying || tabPendingCount(tab) > 0) return false
      patchTab(id, (t) => ({ ...t, database }))
      void useSessionsStore.getState().setCurrentDatabase(tab.connectionId, database)
      return true
    },

    run: async (id, sql) => {
      const tab = findTab(id)
      if (!tab) return "empty"
      if (tab.running) return "busy"
      if (tabPendingCount(tab) > 0) return "pending-edits"
      const text = sql ?? tab.sql
      if (text.trim() === "") return "empty"
      patchTab(id, startRun)
      const runId = tab.runId
      const isCurrent = (t: QueryTab) => t.runId === runId
      // Without a tab database the statement runs in the session's current one. Send it
      // explicitly, so the backend can't run in another database than the one recorded here.
      const session = useSessionsStore.getState().sessions[tab.connectionId]
      const ranDatabase = tab.database ?? session?.currentDatabase ?? null
      try {
        const options = { maxRows: maxRows(), ...(ranDatabase ? { database: ranDatabase } : {}) }
        const results = await mysqlApi.query(tab.connectionId, text, options)
        patchTab(id, (t) => (isCurrent(t) ? finishRun(t, text, results, ranDatabase) : t))
        noteReconnects(tab.connectionId, results)
        return "ran"
      } catch (raw) {
        const error = normalizeError(raw)
        patchTab(id, (t) => (isCurrent(t) ? failRun(t, text, error) : t))
        return "failed"
      }
    },

    updateEdits: (id, index, update) =>
      patchTab(id, (tab) => setTabEdits(tab, index, update(tab.edits[index] ?? EMPTY_EDITS))),

    discardEdits: (id, index) => patchTab(id, (tab) => setTabEdits(tab, index, EMPTY_EDITS)),

    applyEdits: async (id, index, target) => {
      const tab = findTab(id)
      const result = tab?.results[index]
      const edits = tab?.edits[index]
      if (!tab || tab.applying || !result || result.kind !== "rows" || !edits) return null
      const changes = buildRowChanges(edits, target, result.columns, result.rows)
      if (changes.length === 0) return null
      patchTab(id, (t) => ({ ...t, applying: true }))
      try {
        return await sendEdits(id, tab.connectionId, index, target, result.statement, changes)
      } finally {
        patchTab(id, (t) => ({ ...t, applying: false }))
      }
    },
  }
})

export function selectActiveTab(state: TabsState): WorkspaceTab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null
}

export function selectActiveQueryTab(state: TabsState): QueryTab | null {
  const tab = selectActiveTab(state)
  return tab?.kind === "query" ? tab : null
}

export function selectActiveDynamoTab(state: TabsState): DynamoTab | null {
  const tab = selectActiveTab(state)
  return tab?.kind === "dynamo" ? tab : null
}

export function selectActiveTableTab(state: TabsState): TableTab | null {
  const tab = selectActiveTab(state)
  return tab?.kind === "table" ? tab : null
}
