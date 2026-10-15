import type { ConnectionId } from "../../lib/connections"
import type { AppError } from "../../lib/ipc"
import type { SchemaTable } from "../../lib/mysql"

/**
 * Path of a sidebar tree node: the connection id, then the database, then the table, joined by
 * NUL (which can't appear in either name). A DynamoDB table sits right under its connection.
 */
export type TreeKey = string

const SEPARATOR = "\u0000"

export const connectionKey = (connectionId: ConnectionId): TreeKey => connectionId

export const childKey = (parent: TreeKey, name: string): TreeKey => `${parent}${SEPARATOR}${name}`

export const databaseKey = (connectionId: ConnectionId, database: string): TreeKey =>
  childKey(connectionKey(connectionId), database)

/** True when `key` lies anywhere below `ancestor`. */
export const isDescendant = (key: TreeKey, ancestor: TreeKey): boolean =>
  key.startsWith(`${ancestor}${SEPARATOR}`)

/** The tree only shows a filter box under a database once it has this many tables. */
export const TABLE_FILTER_THRESHOLD = 50

export interface TreeChild {
  name: string
  kind: "database" | "table" | "view"
}

/** Children of one node: a connection's databases or a database's tables and views. */
export interface NodeLoad {
  status: "loading" | "ready" | "error"
  /** Last loaded children; kept while a refresh runs. */
  children: readonly TreeChild[] | null
  error: AppError | null
  /** Increments on every request so a late response can't overwrite a newer one. */
  requestId: number
}

export interface TreeState {
  expanded: Readonly<Record<TreeKey, boolean>>
  loads: Readonly<Record<TreeKey, NodeLoad>>
  /** Table filter text keyed by database node. */
  filters: Readonly<Record<TreeKey, string>>
  /** Node that holds the tree's single tab stop. */
  focused: TreeKey | null
}

export const INITIAL_TREE: TreeState = { expanded: {}, loads: {}, filters: {}, focused: null }

const omitKeys = <T>(
  record: Readonly<Record<TreeKey, T>>,
  drop: (key: TreeKey) => boolean,
): Record<TreeKey, T> => Object.fromEntries(Object.entries(record).filter(([k]) => !drop(k)))

/** Expands or collapses a node. Collapsing moves the tab stop off any hidden descendant. */
export function setExpanded(state: TreeState, key: TreeKey, expanded: boolean): TreeState {
  const focused =
    !expanded && state.focused !== null && isDescendant(state.focused, key) ? key : state.focused
  return { ...state, expanded: { ...state.expanded, [key]: expanded }, focused }
}

export function toggleExpanded(state: TreeState, key: TreeKey): TreeState {
  return setExpanded(state, key, !state.expanded[key])
}

/** Starts a request for `key`'s children; earlier children stay visible until it answers. */
export function startLoad(state: TreeState, key: TreeKey): TreeState {
  const previous = state.loads[key]
  const load: NodeLoad = {
    status: "loading",
    children: previous?.children ?? null,
    error: null,
    requestId: (previous?.requestId ?? 0) + 1,
  }
  return { ...state, loads: { ...state.loads, [key]: load } }
}

/** The tab stop stays on a child that still exists, else it moves up to `key`. */
function keepFocus(state: TreeState, key: TreeKey, children: readonly TreeChild[]) {
  const { focused } = state
  if (focused === null || !isDescendant(focused, key)) return focused
  const name = focused.slice(key.length + SEPARATOR.length).split(SEPARATOR)[0]
  return children.some((c) => c.name === name) ? focused : key
}

/** Stores the children when `requestId` is still the latest request for `key`. */
export function finishLoad(
  state: TreeState,
  key: TreeKey,
  requestId: number,
  children: readonly TreeChild[],
): TreeState {
  const current = state.loads[key]
  if (!current || current.requestId !== requestId) return state
  const load: NodeLoad = { status: "ready", children, error: null, requestId }
  return {
    ...state,
    loads: { ...state.loads, [key]: load },
    focused: keepFocus(state, key, children),
  }
}

/** Records a failure when `requestId` is still the latest request for `key`. */
export function failLoad(
  state: TreeState,
  key: TreeKey,
  requestId: number,
  error: AppError,
): TreeState {
  const current = state.loads[key]
  if (!current || current.requestId !== requestId) return state
  const load: NodeLoad = { ...current, status: "error", error }
  return { ...state, loads: { ...state.loads, [key]: load } }
}

/** True when the node has never loaded or its last load failed. */
export function needsLoad(state: TreeState, key: TreeKey): boolean {
  const load = state.loads[key]
  return !load || load.status === "error"
}

export function setFilter(state: TreeState, key: TreeKey, text: string): TreeState {
  return { ...state, filters: { ...state.filters, [key]: text } }
}

export function setFocused(state: TreeState, key: TreeKey | null): TreeState {
  return state.focused === key ? state : { ...state, focused: key }
}

/** Drops every node of a deleted connection. */
export function forgetConnection(state: TreeState, connectionId: ConnectionId): TreeState {
  const root = connectionKey(connectionId)
  const drop = (key: TreeKey) => key === root || isDescendant(key, root)
  return {
    expanded: omitKeys(state.expanded, drop),
    loads: omitKeys(state.loads, drop),
    filters: omitKeys(state.filters, drop),
    focused: state.focused !== null && drop(state.focused) ? null : state.focused,
  }
}

export function databaseChildren(names: readonly string[]): TreeChild[] {
  return names.map((name) => ({ name, kind: "database" }))
}

export function tableChildren(tables: readonly SchemaTable[]): TreeChild[] {
  return tables.map((t) => ({ name: t.name, kind: t.kind }))
}

/** Case-insensitive substring match on the name. */
export function filterChildren(children: readonly TreeChild[], query: string): TreeChild[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...children]
  return children.filter((c) => c.name.toLowerCase().includes(needle))
}
