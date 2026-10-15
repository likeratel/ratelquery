import { create } from "zustand"
import type { ConnectionId } from "../lib/connections"
import { buildRowChanges, EMPTY_EDITS, type EditTarget, type GridEdits } from "../lib/gridEdits"
import { normalizeError } from "../lib/ipc"
import { mysqlApi, type ApplyChangesResult, type QueryResult } from "../lib/mysql"
import {
  activateTab,
  closeTab,
  failRun,
  finishRun,
  INITIAL_TABS,
  openTab,
  replaceResult,
  setTabEdits,
  startRun,
  tabPendingCount,
  updateTab,
  type QueryTab,
  type TabsState,
} from "../lib/queryTabs"
import { useSessionsStore } from "./sessionsStore"

/** Default row cap per statement; matches the backend default. */
export const MAX_ROWS = 1000

export type RunOutcome = "ran" | "failed" | "empty" | "busy" | "pending-edits"

interface TabsStore extends TabsState {
  open: (connectionId: ConnectionId, database: string | null) => string
  close: (id: string) => void
  activate: (id: string) => void
  setSql: (id: string, sql: string) => void
  setActiveResult: (id: string, index: number) => void
  setDatabase: (id: string, database: string | null) => void
  /** Runs `sql` (the whole editor text when omitted) in the tab. */
  run: (id: string, sql?: string) => Promise<RunOutcome>
  updateEdits: (id: string, index: number, update: (edits: GridEdits) => GridEdits) => void
  discardEdits: (id: string, index: number) => void
  /** Sends pending edits for one result in a single transaction, then re-runs its statement. */
  applyEdits: (id: string, index: number, target: EditTarget) => Promise<ApplyChangesResult | null>
}

const newId = () => crypto.randomUUID()

export const useTabsStore = create<TabsStore>((set, get) => {
  const findTab = (id: string): QueryTab | undefined => get().tabs.find((t) => t.id === id)
  const patchTab = (id: string, update: (tab: QueryTab) => QueryTab) =>
    set((state) => updateTab(state, id, update))

  const noteReconnects = (connectionId: ConnectionId, results: readonly QueryResult[]) => {
    if (results.some((r) => r.reconnected)) {
      useSessionsStore.getState().markReconnected(connectionId)
    }
  }

  return {
    ...INITIAL_TABS,

    open: (connectionId, database) => {
      const id = newId()
      set((state) => openTab(state, { id, connectionId, database }))
      return id
    },

    close: (id) => set((state) => closeTab(state, id)),

    activate: (id) => set((state) => activateTab(state, id)),

    setSql: (id, sql) => patchTab(id, (tab) => ({ ...tab, sql })),

    setActiveResult: (id, index) => patchTab(id, (tab) => ({ ...tab, activeResult: index })),

    setDatabase: (id, database) => {
      const tab = findTab(id)
      if (!tab) return
      patchTab(id, (t) => ({ ...t, database }))
      void useSessionsStore.getState().setCurrentDatabase(tab.connectionId, database)
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
      try {
        const options = { maxRows: MAX_ROWS, ...(tab.database ? { database: tab.database } : {}) }
        const results = await mysqlApi.query(tab.connectionId, text, options)
        patchTab(id, (t) => (isCurrent(t) ? finishRun(t, text, results) : t))
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
      if (!tab || !result || result.kind !== "rows" || !edits) return null
      const changes = buildRowChanges(edits, target, result.columns, result.rows)
      if (changes.length === 0) return null
      const applied = await mysqlApi.applyChanges(
        tab.connectionId,
        target.database,
        target.table,
        changes,
      )
      const options = { maxRows: MAX_ROWS, database: target.database }
      try {
        const [rerun] = await mysqlApi.query(tab.connectionId, result.statement, options)
        if (rerun) {
          patchTab(id, (t) => replaceResult(t, index, rerun))
          noteReconnects(tab.connectionId, [rerun])
        }
      } catch (raw) {
        // Changes are committed; only the refresh failed. Clear the edits and surface the error.
        patchTab(id, (t) => ({ ...setTabEdits(t, index, EMPTY_EDITS), error: normalizeError(raw) }))
      }
      return applied
    },
  }
})

export function selectActiveTab(state: TabsState): QueryTab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null
}
