import { create } from "zustand"
import type { ConnectionId } from "../../lib/connections"
import type { AppError } from "../../lib/ipc"
import {
  failLoad,
  finishLoad,
  forgetConnection,
  INITIAL_TREE,
  setExpanded,
  setFilter,
  setFocused,
  startLoad,
  toggleExpanded,
  type TreeChild,
  type TreeKey,
  type TreeState,
} from "./treeState"

interface TreeStore extends TreeState {
  toggle: (key: TreeKey) => void
  setExpanded: (key: TreeKey, expanded: boolean) => void
  /** Starts a children request for `key` and returns its id for `resolve` / `reject`. */
  begin: (key: TreeKey) => number
  resolve: (key: TreeKey, requestId: number, children: readonly TreeChild[]) => void
  reject: (key: TreeKey, requestId: number, error: AppError) => void
  setFilter: (key: TreeKey, text: string) => void
  setFocused: (key: TreeKey | null) => void
  forget: (connectionId: ConnectionId) => void
}

/** Sidebar schema tree: expansion, per-node loading and the roving tab stop. */
export const useSchemaTree = create<TreeStore>((set, get) => ({
  ...INITIAL_TREE,

  toggle: (key) => set((state) => toggleExpanded(state, key)),

  setExpanded: (key, expanded) => set((state) => setExpanded(state, key, expanded)),

  begin: (key) => {
    set((state) => startLoad(state, key))
    return get().loads[key]?.requestId ?? 0
  },

  resolve: (key, requestId, children) =>
    set((state) => finishLoad(state, key, requestId, children)),

  reject: (key, requestId, error) => set((state) => failLoad(state, key, requestId, error)),

  setFilter: (key, text) => set((state) => setFilter(state, key, text)),

  setFocused: (key) => set((state) => setFocused(state, key)),

  forget: (connectionId) => set((state) => forgetConnection(state, connectionId)),
}))
