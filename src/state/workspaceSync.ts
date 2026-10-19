import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { ConnectionConfig, ConnectionId } from "../lib/connections"
import {
  diffWorkspace,
  EMPTY_WORKSPACE,
  restoreTabs,
  serializeWorkspace,
  workspaceApi,
  type Workspace,
} from "../lib/workspace"
import { useConnectionsStore } from "./connectionsStore"
import { useTabsStore } from "./tabsStore"

/** Editor text is saved once typing pauses this long. */
export const SQL_SAVE_DELAY_MS = 1000

/** Longest the window waits for the last save when it closes. */
export const CLOSE_SAVE_TIMEOUT_MS = 1500

/** Resolves when `work` settles or after `ms`, whichever comes first; never rejects. */
function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  return Promise.race([work.catch(() => undefined), timeout]).finally(() => clearTimeout(timer))
}

/**
 * In the desktop shell, the main window's close request waits for `beforeClose` (the window is
 * then destroyed by the API, which needs `core:window:allow-destroy`). Quitting from the app
 * menu does not send a close request, so `pagehide` also starts a save; the page may be gone
 * before it finishes.
 */
export function onWindowClose(beforeClose: () => Promise<void>): () => void {
  const onPageHide = () => void beforeClose()
  window.addEventListener("pagehide", onPageHide)
  let unlisten: (() => void) | null = null
  let disposed = false
  if (isTauri()) {
    getCurrentWindow()
      .onCloseRequested(() => beforeClose())
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch((error: unknown) => console.warn("Couldn't watch the window closing", error))
  }
  return () => {
    disposed = true
    window.removeEventListener("pagehide", onPageHide)
    unlisten?.()
  }
}

export interface WorkspaceSyncDeps {
  load: () => Promise<Workspace | null>
  save: (workspace: Workspace) => Promise<void>
  /** Reports a failed load or save; no toast, the tabs themselves are fine. */
  warn: (message: string, error: unknown) => void
  sqlDelayMs: number
  /**
   * Registers `beforeClose` to run (and be awaited, where the platform allows) before the app
   * window closes. Returns the unregister function.
   */
  onClose: (beforeClose: () => Promise<void>) => () => void
}

export interface WorkspaceSync {
  /**
   * Reopens the saved tabs once, for the given connections; later calls share or skip it.
   * Nothing is saved before this finished, so the empty startup state never replaces the file.
   * A failed load leaves saving off for this run (the file may still hold the tabs) and is not
   * retried.
   */
  restore: (byId: (id: ConnectionId) => ConnectionConfig | undefined) => Promise<void>
  /**
   * Saves on tab changes and restores once the connection list is ready. Opening, closing,
   * switching tabs or changing a tab's database saves right away (changes in the same task are
   * merged); editor text is saved after `sqlDelayMs` without typing, or when the window closes
   * (best effort, see `onWindowClose`). Returns the stop function, which writes a pending text
   * change at once.
   */
  start: () => () => void
}

export function createWorkspaceSync(deps: WorkspaceSyncDeps): WorkspaceSync {
  let restored = false
  let loadFailed = false
  let restoring: Promise<void> | null = null
  /** The workspace as of the last change seen, to tell text edits from tab changes. */
  let seen: Workspace = EMPTY_WORKSPACE
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushQueued = false
  /** Saves run one after another, so an older write can never land after a newer one. */
  let chain: Promise<void> = Promise.resolve()
  /** A save is waiting in `chain` and has not read the tabs yet; later requests join it. */
  let pendingWrite = false
  let warned = false

  const current = () => serializeWorkspace(useTabsStore.getState())

  const save = async () => {
    pendingWrite = false
    try {
      await deps.save(current())
      warned = false
    } catch (error) {
      // Once per failure streak, so a broken disk doesn't log on every keystroke.
      if (!warned) deps.warn("Couldn't save the open tabs", error)
      warned = true
    }
  }

  /** Resolves once the latest tabs are on disk (or the save failed). */
  const write = (): Promise<void> => {
    if (!pendingWrite) {
      pendingWrite = true
      chain = chain.then(save)
    }
    return chain
  }

  /** Writes whatever is waiting (a queued tab change or debounced text) now. */
  const flush = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    flushQueued = false
    return restored ? write() : Promise.resolve()
  }

  const flushSoon = () => {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      if (flushQueued) void flush()
    })
  }

  const flushLater = () => {
    if (flushQueued) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => void flush(), deps.sqlDelayMs)
  }

  const onTabsChange = (
    state: ReturnType<typeof useTabsStore.getState>,
    prev: ReturnType<typeof useTabsStore.getState>,
  ) => {
    if (!restored || (state.tabs === prev.tabs && state.activeId === prev.activeId)) return
    const next = serializeWorkspace(state)
    const change = diffWorkspace(seen, next)
    seen = next
    if (change === "structure") flushSoon()
    else if (change === "sql") flushLater()
  }

  const runRestore = async (byId: (id: ConnectionId) => ConnectionConfig | undefined) => {
    let saved: Workspace | null
    try {
      saved = await deps.load()
    } catch (error) {
      deps.warn("Couldn't load the saved tabs", error)
      loadFailed = true
      return
    }
    const result = restoreTabs(saved ?? EMPTY_WORKSPACE, byId)
    if (result.tabs.length > 0) {
      useTabsStore.getState().restore(result.tabs, result.activeId, result.seq)
    }
    seen = current()
    restored = true
    // Dropped tabs, or tabs opened while loading, make the file out of date already.
    if (diffWorkspace(saved ?? EMPTY_WORKSPACE, seen) !== "none") flushSoon()
  }

  const restore: WorkspaceSync["restore"] = (byId) => {
    if (restored || loadFailed) return Promise.resolve()
    restoring ??= runRestore(byId).finally(() => {
      restoring = null
    })
    return restoring
  }

  const start = () => {
    const offTabs = useTabsStore.subscribe(onTabsChange)
    const restoreWhenReady = (state: ReturnType<typeof useConnectionsStore.getState>) => {
      if (state.status === "ready") void restore(state.byId)
    }
    restoreWhenReady(useConnectionsStore.getState())
    const offConnections = useConnectionsStore.subscribe(restoreWhenReady)
    // Best effort: the debounced text of the last second is written before the window goes.
    const offClose = deps.onClose(() => withTimeout(flush(), CLOSE_SAVE_TIMEOUT_MS))
    return () => {
      offTabs()
      offConnections()
      offClose()
      if (timer !== null) void flush()
    }
  }

  return { restore, start }
}

const appSync = createWorkspaceSync({
  load: workspaceApi.load,
  save: workspaceApi.save,
  warn: (message, error) => console.warn(message, error),
  sqlDelayMs: SQL_SAVE_DELAY_MS,
  onClose: onWindowClose,
})

/** Mounted once by the shell; see `WorkspaceSync.start`. */
export function startWorkspaceSync(): () => void {
  return appSync.start()
}
