import { create } from "zustand"
import { showToast } from "../components/ui/toastStore"
import {
  connectionLayoutApi,
  createFolder,
  EMPTY_LAYOUT,
  newFolderName,
  reconcileLayout,
  type ConnectionLayout,
  type FolderId,
} from "../lib/connectionLayout"
import { errorDetail } from "../features/connections/errors"
import { normalizeError } from "../lib/ipc"
import { useConnectionsStore, type LoadStatus } from "./connectionsStore"

interface ConnectionLayoutState {
  /** As loaded or last changed; render through `reconcileLayout` with the current connections. */
  layout: ConnectionLayout
  status: LoadStatus
  /** Folder whose name is being edited in place. */
  renaming: FolderId | null
  load: () => Promise<void>
  /**
   * Applies `change` to the layout reconciled with the current connections, keeps the result
   * and saves it. A failed save leaves the change in place and warns once per failure streak.
   * Ignored while the saved layout is loading.
   */
  update: (change: (layout: ConnectionLayout) => ConnectionLayout) => void
  /** Adds a "New folder" at the end of the list, or of folder `parent`, and starts renaming it. */
  createFolder: (parent?: FolderId) => FolderId
  setRenaming: (id: FolderId | null) => void
}

/** The layout for the connections listed right now. */
export function currentLayout(): ConnectionLayout {
  return reconcileLayout(
    useConnectionLayout.getState().layout,
    useConnectionsStore.getState().connections,
  )
}

let loadToken = 0
/** Saves run one after another, so an older layout never lands after a newer one. */
let chain: Promise<void> = Promise.resolve()
let warned = false

function save(layout: ConnectionLayout): void {
  chain = chain.then(async () => {
    try {
      await connectionLayoutApi.save(layout)
      warned = false
    } catch (raw) {
      if (warned) return
      warned = true
      showToast({
        tone: "warning",
        message: "Couldn't save the connection order. It is kept until the app quits.",
        detail: errorDetail(normalizeError(raw)),
      })
    }
  })
}

export const useConnectionLayout = create<ConnectionLayoutState>((set, get) => ({
  layout: EMPTY_LAYOUT,
  status: "idle",
  renaming: null,

  load: async () => {
    const token = ++loadToken
    set({ status: "loading" })
    try {
      const saved = await connectionLayoutApi.load()
      if (token !== loadToken) return
      set({ layout: saved ?? EMPTY_LAYOUT, status: "ready" })
    } catch (raw) {
      if (token !== loadToken) return
      // The name order is a fine fallback; nothing is lost until the user changes the order.
      console.warn("Couldn't load the connection order", normalizeError(raw))
      set({ status: "error" })
    }
  },

  update: (change) => {
    // Changing an order that hasn't loaded yet would overwrite the saved one.
    if (get().status === "loading") return
    // Without the connection list every placed id would look deleted; keep them as saved.
    const base = useConnectionsStore.getState().status === "ready" ? currentLayout() : get().layout
    const next = change(base)
    if (next === base) return
    set({ layout: next })
    save(next)
  },

  createFolder: (parent) => {
    const id = crypto.randomUUID()
    get().update((layout) => createFolder(layout, id, newFolderName(layout), parent))
    if (get().layout.folders.some((f) => f.id === id)) set({ renaming: id })
    return id
  },

  setRenaming: (id) => set({ renaming: id }),
}))
