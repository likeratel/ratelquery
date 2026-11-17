import { create } from "zustand"
import { normalizeError } from "../lib/ipc"
import {
  trashApi,
  type RestoreOptions,
  type RestoreResult,
  type TrashEntry,
  type TrashSummary,
} from "../lib/trash"

/** The SQL preview of a restore waiting for confirmation. */
export type RestorePreviewState =
  | { status: "loading" }
  | {
      status: "ready"
      statements: readonly string[]
      total: number
      warning: string | null
      nonTransactionalEngine: string | null
    }
  | { status: "error"; message: string }

/** Where a restore goes, for the confirmation. */
export interface RestoreTarget {
  connectionName: string
  /** True unless it is the entry's own connection. */
  otherConnection: boolean
}

export interface PendingRestore {
  id: string
  options: RestoreOptions
  /** Rows it restores. */
  count: number
  target: RestoreTarget
  preview: RestorePreviewState
}

interface TrashState {
  summaries: readonly TrashSummary[]
  loaded: boolean
  loadError: string | null
  selectedId: string | null
  entry: TrashEntry | null
  entryError: string | null
  restore: PendingRestore | null
  /** True while a confirmed restore runs. */
  restoring: boolean
  /** Re-reads the list; the open entry only when its summary changed. */
  refresh: () => Promise<void>
  /** Opens an entry's rows; null closes it. */
  select: (id: string | null) => Promise<void>
  /** Shows the restore confirmation and loads its SQL preview. */
  requestRestore: (
    id: string,
    options: RestoreOptions,
    count: number,
    target: RestoreTarget,
  ) => void
  cancelRestore: () => void
  /** Runs the confirmed restore. Rejects with the AppError; resolves null when nothing waited. */
  confirmRestore: () => Promise<RestoreResult | null>
  remove: (id: string) => Promise<void>
  /** Resolves to how many entries were removed. */
  empty: () => Promise<number>
}

/** Whether the open entry's summary changed, so its rows are read again. */
function summaryChanged(before: TrashSummary | undefined, after: TrashSummary): boolean {
  return (
    !before ||
    before.rowCount !== after.rowCount ||
    before.status !== after.status ||
    before.deletedAt !== after.deletedAt
  )
}

/** Answers older than the latest request of the same kind are dropped. */
let listRequest = 0
let entryRequest = 0

export const useTrashStore = create<TrashState>((set, get) => {
  const loadEntry = async (id: string) => {
    const request = ++entryRequest
    try {
      const entry = await trashApi.get(id)
      if (request === entryRequest) set({ entry, entryError: null })
    } catch (raw) {
      if (request !== entryRequest) return
      const error = normalizeError(raw)
      // A removed entry just closes.
      if (error.kind === "not_found") set({ selectedId: null, entry: null, entryError: null })
      else set({ entry: null, entryError: error.message })
    }
  }

  return {
    summaries: [],
    loaded: false,
    loadError: null,
    selectedId: null,
    entry: null,
    entryError: null,
    restore: null,
    restoring: false,

    refresh: async () => {
      const request = ++listRequest
      try {
        const before = get().summaries
        const summaries = await trashApi.list()
        if (request !== listRequest) return
        set({ summaries, loaded: true, loadError: null })
        const selected = get().selectedId
        const now = summaries.find((s) => s.id === selected)
        if (selected && !now) {
          set({ selectedId: null, entry: null, entryError: null })
        } else if (
          selected &&
          now &&
          summaryChanged(
            before.find((s) => s.id === selected),
            now,
          )
        ) {
          await loadEntry(selected)
        }
      } catch (raw) {
        if (request === listRequest) set({ loadError: normalizeError(raw).message })
      }
    },

    select: async (id) => {
      set({ selectedId: id, entry: null, entryError: null })
      if (id) await loadEntry(id)
      else entryRequest++
    },

    requestRestore: (id, options, count, target) => {
      const pending: PendingRestore = { id, options, count, target, preview: { status: "loading" } }
      set({ restore: pending })
      const settle = (preview: RestorePreviewState) => {
        const current = get().restore
        // Only the dialog this preview was asked for.
        if (current?.id === id && current.options === options) {
          set({ restore: { ...current, preview } })
        }
      }
      trashApi.restorePreview(id, options).then(
        (preview) => settle({ status: "ready", ...preview }),
        (raw: unknown) => settle({ status: "error", message: normalizeError(raw).message }),
      )
    },

    cancelRestore: () => set({ restore: null }),

    confirmRestore: async () => {
      const pending = get().restore
      if (!pending || pending.preview.status === "loading" || get().restoring) return null
      set({ restore: null, restoring: true })
      try {
        return await trashApi.restore(pending.id, pending.options)
      } finally {
        set({ restoring: false })
        await get().refresh()
      }
    },

    remove: async (id) => {
      try {
        await trashApi.delete(id)
      } finally {
        await get().refresh()
      }
    },

    empty: async () => {
      try {
        return await trashApi.empty()
      } finally {
        await get().refresh()
      }
    },
  }
})

/** Reloads the trash list; for after a delete that saved rows. Errors stay in the store. */
export function refreshTrash(): void {
  void useTrashStore.getState().refresh()
}

/** How often a long-running window asks the backend to drop expired entries. */
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000

let lastPurge = Date.now()

/** On focus: purges once a day (the app may stay open for weeks), then reloads the list. */
export async function onTrashFocus(now = Date.now()): Promise<void> {
  if (now - lastPurge >= PURGE_INTERVAL_MS) {
    lastPurge = now
    await trashApi.purge().catch(() => {
      // The next focus a day later tries again; the startup purge covers restarts.
    })
  }
  await useTrashStore.getState().refresh()
}

const onFocus = () => void onTrashFocus()

/**
 * Loads the list now and again whenever the window gets focus (another app instance or a purge
 * may have changed it). The backend purged at startup. Returns the cleanup.
 */
export function startTrashSync(): () => void {
  refreshTrash()
  window.addEventListener("focus", onFocus)
  return () => window.removeEventListener("focus", onFocus)
}
