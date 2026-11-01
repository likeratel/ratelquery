import { create } from "zustand"
import type { FindBarState } from "../../lib/dynamoSearch"

/**
 * The item panel's find bar, per tab and table. It lives outside the tabs store so typing a
 * query re-renders the panel only, and it outlives the panel so the query stays while moving
 * between items.
 */
interface ItemFindState {
  bars: Readonly<Record<string, FindBarState>>
  /** Set by Mod+F until the tree's find bar has taken focus. */
  focusBar: boolean
  /** Bumped by Mod+F while the panel shows JSON; its editor opens its search panel. */
  jsonSearch: number
}

export const useItemFind = create<ItemFindState>(() => ({
  bars: {},
  focusBar: false,
  jsonSearch: 0,
}))

export const CLOSED_FIND: FindBarState = { open: false, query: "" }

/** Key of a tab's find bar for one table; another table starts with a closed bar. */
export const findBarKey = (tabId: string, table: string | null) => `${tabId}\n${table ?? ""}`

export function setFindBar(key: string, next: FindBarState): void {
  useItemFind.setState((s) => ({ bars: { ...s.bars, [key]: next } }))
}

/** Opens the find bar (keeping its query) and has it take focus with its query selected. */
export function requestFind(key: string): void {
  useItemFind.setState((s) => ({
    bars: { ...s.bars, [key]: { ...(s.bars[key] ?? CLOSED_FIND), open: true } },
    focusBar: true,
  }))
}

export function findBarFocused(): void {
  useItemFind.setState({ focusBar: false })
}

/** Opens the search of the panel's JSON view. */
export function requestJsonSearch(): void {
  useItemFind.setState((s) => ({ jsonSearch: s.jsonSearch + 1 }))
}
