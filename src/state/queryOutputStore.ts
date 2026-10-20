import { create } from "zustand"
import type { ConnectionId } from "../lib/connections"
import type { AppError } from "../lib/ipc"
import type { QueryResult } from "../lib/mysql"
import {
  appendEntries,
  dropConnection,
  EMPTY_OUTPUT_LOG,
  entriesFromResults,
  entryFromCancel,
  entryFromError,
  pruneLog,
  type EntryContext,
  type OutputEntry,
  type OutputLog,
  type OutputScope,
} from "../lib/queryOutput"

/** The two views of a query tab's bottom panel. */
export type BottomPanel = "results" | "output"

interface QueryOutputStore {
  log: OutputLog
  /** Query tabs whose Output holds an error that wasn't shown yet. */
  unseenErrors: Readonly<Record<string, true>>
  /** Bottom panel each query tab shows; Results when absent. */
  panels: Readonly<Record<string, BottomPanel>>
  /** What the Output view lists; shared by every tab. */
  scope: OutputScope
  record: (entries: readonly OutputEntry[]) => void
  /**
   * Puts the saved log in front of the entries recorded this session (an id already saved is
   * not added twice), keeping the per-connection cap.
   */
  hydrate: (saved: OutputLog) => void
  markSeen: (tabId: string) => void
  setPanel: (tabId: string, panel: BottomPanel) => void
  setScope: (scope: OutputScope) => void
  /** Drops entries older than `retentionDays` before `now` (see `pruneLog`). */
  prune: (retentionDays: number, now: number) => void
  /** Drops every entry of a deleted connection. */
  forgetConnection: (connectionId: ConnectionId) => void
  /** Drops a closed tab's view state; its entries stay for "All on this connection". */
  forgetTab: (tabId: string) => void
}

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string) => {
  if (!(key in record)) return record
  const { [key]: _dropped, ...rest } = record
  return rest
}

export const useQueryOutputStore = create<QueryOutputStore>((set) => ({
  log: EMPTY_OUTPUT_LOG,
  unseenErrors: {},
  panels: {},
  scope: "tab",

  record: (entries) =>
    set((state) => {
      const errorTabs = entries.filter((e) => e.outcome.kind === "error").map((e) => e.tabId)
      return {
        log: appendEntries(state.log, entries),
        unseenErrors:
          errorTabs.length === 0
            ? state.unseenErrors
            : { ...state.unseenErrors, ...Object.fromEntries(errorTabs.map((id) => [id, true])) },
      }
    }),

  hydrate: (saved) =>
    set((state) => ({
      log: appendEntries(saved, Object.values(state.log).flat()),
    })),

  markSeen: (tabId) =>
    set((state) => {
      const unseenErrors = withoutKey(state.unseenErrors, tabId)
      return unseenErrors === state.unseenErrors ? state : { unseenErrors }
    }),

  setPanel: (tabId, panel) => set((state) => ({ panels: { ...state.panels, [tabId]: panel } })),

  setScope: (scope) => set({ scope }),

  prune: (retentionDays, now) =>
    set((state) => {
      const log = pruneLog(state.log, retentionDays, now)
      return log === state.log ? state : { log }
    }),

  forgetConnection: (connectionId) =>
    set((state) => {
      const log = dropConnection(state.log, connectionId)
      return log === state.log ? state : { log }
    }),

  forgetTab: (tabId) =>
    set((state) => ({
      panels: withoutKey(state.panels, tabId),
      unseenErrors: withoutKey(state.unseenErrors, tabId),
    })),
}))

const newId = () => crypto.randomUUID()

const context = (connectionId: ConnectionId, tabId: string): EntryContext => ({
  connectionId,
  tabId,
  at: Date.now(),
  newId,
})

/** Logs every statement of a finished run. */
export function logRunResults(
  connectionId: ConnectionId,
  tabId: string,
  results: readonly QueryResult[],
): void {
  useQueryOutputStore.getState().record(entriesFromResults(context(connectionId, tabId), results))
}

/** Logs a run that failed (`cancelled` false) or that the user stopped. */
export function logRunFailure(
  connectionId: ConnectionId,
  tabId: string,
  sql: string,
  outcome: { error: AppError; cancelled: boolean; elapsedMs: number | null },
): void {
  const ctx = context(connectionId, tabId)
  const entry = outcome.cancelled
    ? entryFromCancel(ctx, sql, outcome.elapsedMs)
    : entryFromError(ctx, sql, outcome.error, outcome.elapsedMs)
  useQueryOutputStore.getState().record([entry])
}

/** Test seam: back to an empty log and default view state. */
export function resetQueryOutputStore(): void {
  useQueryOutputStore.setState({
    log: EMPTY_OUTPUT_LOG,
    unseenErrors: {},
    panels: {},
    scope: "tab",
  })
}
