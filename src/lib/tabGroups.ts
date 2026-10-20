/**
 * Tabs grouped under their connection. The tab bar shows one connection tab per group and,
 * below it, only the tabs of the active connection, so it is always clear which server a tab
 * talks to. Groups keep the order in which their connection first appears in the tab list.
 */
import type { ConnectionId } from "./connections"

interface TabLike {
  id: string
  connectionId: ConnectionId
}

export interface TabGroup {
  connectionId: ConnectionId
  tabIds: readonly string[]
}

/** Last active tab per connection, so switching back to a connection returns to that tab. */
export type RecentTabs = Readonly<Record<ConnectionId, string>>

interface GroupState {
  tabs: readonly TabLike[]
  activeId: string | null
  recent: RecentTabs
}

/** Number keys 1-8 pick that position, 9 always picks the last one (as in Chrome). */
export const SLOT_COUNT = 9

/** The groups of `tabs`, ordered by the first tab of each connection. */
export function tabGroups(tabs: readonly TabLike[]): TabGroup[] {
  const order: ConnectionId[] = []
  const ids = new Map<ConnectionId, string[]>()
  for (const tab of tabs) {
    const found = ids.get(tab.connectionId)
    if (found) found.push(tab.id)
    else {
      order.push(tab.connectionId)
      ids.set(tab.connectionId, [tab.id])
    }
  }
  return order.map((connectionId) => ({ connectionId, tabIds: ids.get(connectionId) ?? [] }))
}

/** Ids of the tabs opened on `connectionId`, in tab order. */
export function groupTabIds(tabs: readonly TabLike[], connectionId: ConnectionId): string[] {
  return tabs.filter((t) => t.connectionId === connectionId).map((t) => t.id)
}

/** The connection of the active tab. */
export function activeConnectionId(
  state: Pick<GroupState, "tabs" | "activeId">,
): ConnectionId | null {
  return state.tabs.find((t) => t.id === state.activeId)?.connectionId ?? null
}

/** Returns a new list with every group's tabs next to each other, groups in their order. */
export function groupedOrder<T extends TabLike>(tabs: readonly T[]): T[] {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  return tabGroups(tabs).flatMap((group) =>
    group.tabIds.map((id) => byId.get(id)).filter((t): t is T => t !== undefined),
  )
}

/**
 * Returns a new list with `tab` placed after the last tab of its connection, or at the end when
 * the connection has none open, so groups stay together and keep their order.
 */
export function insertTab<T extends TabLike>(tabs: readonly T[], tab: T): T[] {
  const last = tabs.findLastIndex((t) => t.connectionId === tab.connectionId)
  if (last === -1) return [...tabs, tab]
  return [...tabs.slice(0, last + 1), tab, ...tabs.slice(last + 1)]
}

/** Records the active tab as its connection's last active one; same object when unchanged. */
export function rememberActive<S extends GroupState>(state: S): S {
  const connectionId = activeConnectionId(state)
  if (!connectionId || !state.activeId || state.recent[connectionId] === state.activeId) {
    return state
  }
  return { ...state, recent: { ...state.recent, [connectionId]: state.activeId } }
}

/** Drops a closed tab from the remembered ones; same object when it wasn't remembered. */
export function forgetRecent(recent: RecentTabs, tabId: string): RecentTabs {
  if (!Object.values(recent).includes(tabId)) return recent
  return Object.fromEntries(Object.entries(recent).filter(([, id]) => id !== tabId))
}

/** The tab to show for a connection: the one last active there, else its last tab. */
export function rememberedTab(
  state: Pick<GroupState, "tabs" | "recent">,
  connectionId: ConnectionId,
): string | null {
  const ids = groupTabIds(state.tabs, connectionId)
  const recent = state.recent[connectionId]
  if (recent && ids.includes(recent)) return recent
  return ids.at(-1) ?? null
}

/** Item at `slot` (1-based); slot 9 is the last item. Null when there is no such item. */
export function slotItem<T>(items: readonly T[], slot: number): T | null {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) return null
  if (slot === SLOT_COUNT) return items.at(-1) ?? null
  return items[slot - 1] ?? null
}

/** The tab at `slot` within the active connection's group (Mod+1..9). */
export function slotTab(state: Pick<GroupState, "tabs" | "activeId">, slot: number): string | null {
  const connectionId = activeConnectionId(state)
  if (!connectionId) return null
  return slotItem(groupTabIds(state.tabs, connectionId), slot)
}

/** The remembered tab of the connection group at `slot` (Mod+Alt+1..9). */
export function slotGroupTab(state: GroupState, slot: number): string | null {
  const group = slotItem(tabGroups(state.tabs), slot)
  return group ? rememberedTab(state, group.connectionId) : null
}

/**
 * The tab to activate once the active tab `closedId` is closed: its right neighbour within the
 * same connection, else the left one. When it was the connection's last tab, the remembered tab
 * of the next connection group (else the previous one) takes over, so closing a tab never jumps
 * to an unrelated tab of a third connection.
 */
export function nextActiveAfterClose(state: GroupState, closedId: string): string | null {
  const closed = state.tabs.find((t) => t.id === closedId)
  if (!closed) return state.activeId
  const siblings = groupTabIds(state.tabs, closed.connectionId)
  const index = siblings.indexOf(closedId)
  const sibling = siblings[index + 1] ?? siblings[index - 1]
  if (sibling) return sibling
  const groups = tabGroups(state.tabs)
  const groupIndex = groups.findIndex((g) => g.connectionId === closed.connectionId)
  const neighbour = groups[groupIndex + 1] ?? groups[groupIndex - 1]
  return neighbour ? rememberedTab(state, neighbour.connectionId) : null
}
