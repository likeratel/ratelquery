import type { ConnectionConfig, ConnectionId } from "../lib/connections"
import {
  fitToBudget,
  keepConnections,
  pruneLog,
  queryOutputApi,
  serializeOutputLog,
  type OutputFile,
  type OutputLog,
} from "../lib/queryOutput"
import { useConnectionsStore } from "./connectionsStore"
import { useQueryOutputStore } from "./queryOutputStore"
import { useSettingsStore } from "./settingsStore"
import { CLOSE_SAVE_TIMEOUT_MS, onWindowClose, withTimeout } from "./workspaceSync"

/** New entries are saved once runs pause this long. */
export const OUTPUT_SAVE_DELAY_MS = 1000

export interface QueryOutputSyncDeps {
  load: () => Promise<OutputLog>
  /** Null removes the file. */
  save: (file: OutputFile | null) => Promise<void>
  /** Reports a failed load or save; no toast, the log in memory is fine. */
  warn: (message: string, error: unknown) => void
  delayMs: number
  now: () => number
  /** See `onWindowClose`. Returns the unregister function. */
  onClose: (beforeClose: () => Promise<void>) => () => void
}

export interface QueryOutputSync {
  /**
   * Loads the saved log once settings and the connection list are ready, then saves the log
   * after new entries (debounced), a deleted connection or a retention change. Each save prunes
   * entries older than the retention; a retention of 0 removes the file instead and keeps the
   * log for the session only. Nothing is saved before the load finished, and a failed load
   * leaves saving off for this run. Returns the stop function, which writes a pending change.
   */
  start: () => () => void
}

export function createQueryOutputSync(deps: QueryOutputSyncDeps): QueryOutputSync {
  let restored = false
  let restoring = false
  let loadFailed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Saves run one after another, so an older write can never land after a newer one. */
  let chain: Promise<void> = Promise.resolve()
  let pendingWrite = false
  let warned = false

  const retentionDays = () => useSettingsStore.getState().settings.query.outputRetentionDays

  /** What goes to disk now: null when output is kept for the session only. */
  const current = (): OutputFile | null => {
    const days = retentionDays()
    if (days <= 0) return null
    const log = pruneLog(useQueryOutputStore.getState().log, days, deps.now())
    return serializeOutputLog(fitToBudget(log))
  }

  const save = async () => {
    pendingWrite = false
    try {
      await deps.save(current())
      warned = false
    } catch (error) {
      // Once per failure streak, so a broken disk doesn't log after every run.
      if (!warned) deps.warn("Couldn't save the query output", error)
      warned = true
    }
  }

  const write = (): Promise<void> => {
    if (!pendingWrite) {
      pendingWrite = true
      chain = chain.then(save)
    }
    return chain
  }

  const flush = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    return restored ? write() : Promise.resolve()
  }

  const flushLater = () => {
    if (!restored) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => void flush(), deps.delayMs)
  }

  const runRestore = async (byId: (id: ConnectionId) => ConnectionConfig | undefined) => {
    restoring = true
    const days = retentionDays()
    let saved: OutputLog = {}
    if (days > 0) {
      try {
        saved = await deps.load()
      } catch (error) {
        deps.warn("Couldn't load the saved query output", error)
        loadFailed = true
        restoring = false
        return
      }
    }
    // Entries of connections deleted since, and entries past the retention, are dropped.
    const kept = pruneLog(
      keepConnections(saved, (id) => byId(id) !== undefined),
      days,
      deps.now(),
    )
    useQueryOutputStore.getState().hydrate(kept)
    restored = true
    restoring = false
    // Writes the pruned log, or removes a file left from before the retention became 0.
    void flush()
  }

  const maybeRestore = () => {
    if (restored || restoring || loadFailed) return
    const connections = useConnectionsStore.getState()
    if (useSettingsStore.getState().status !== "ready" || connections.status !== "ready") return
    void runRestore(connections.byId)
  }

  const start = () => {
    const offLog = useQueryOutputStore.subscribe((state, prev) => {
      if (state.log !== prev.log) flushLater()
    })
    const offSettings = useSettingsStore.subscribe((state, prev) => {
      maybeRestore()
      const days = state.settings.query.outputRetentionDays
      if (days !== prev.settings.query.outputRetentionDays) void flush()
    })
    const offConnections = useConnectionsStore.subscribe(maybeRestore)
    maybeRestore()
    const offClose = deps.onClose(() => withTimeout(flush(), CLOSE_SAVE_TIMEOUT_MS))
    return () => {
      offLog()
      offSettings()
      offConnections()
      offClose()
      if (timer !== null) void flush()
    }
  }

  return { start }
}

let stopApp: (() => void) | null = null

/**
 * Starts the app's output sync once; later calls do nothing. It runs for the life of the window
 * (runs can finish while another kind of tab is shown).
 */
export function ensureQueryOutputSync(): void {
  if (stopApp) return
  stopApp = createQueryOutputSync({
    load: queryOutputApi.load,
    save: queryOutputApi.save,
    warn: (message, error) => console.warn(message, error),
    delayMs: OUTPUT_SAVE_DELAY_MS,
    now: () => Date.now(),
    onClose: onWindowClose,
  }).start()
}
