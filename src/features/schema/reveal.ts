import { isModalOpen } from "../../components/ui"
import type { AthenaCatalog } from "../../lib/athenaCatalog"
import { expandFoldersAround } from "../../lib/connectionLayout"
import type { ConnectionConfig, ConnectionId } from "../../lib/connections"
import type { AppError } from "../../lib/ipc"
import type { MysqlSessionState } from "../../lib/mysql"
import type { WorkspaceTab } from "../../lib/queryTabs"
import { useAthenaStore } from "../../state/athenaStore"
import { currentLayout, useConnectionLayout } from "../../state/connectionLayoutStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore, type MysqlSession } from "../../state/sessionsStore"
import { useSettingsStore } from "../../state/settingsStore"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"
import { isMysqlSessionLive } from "../connections/connectSession"
import { useDynamoCatalog, type DynamoCatalog } from "../dynamo/catalogStore"
import { athenaTabDatabase, tabDatabase } from "../query/editing"
import {
  childKey,
  connectionKey,
  databaseKey,
  filterChildren,
  isDescendant,
  needsLoad,
  type TreeKey,
  type TreeState,
} from "./treeState"
import { useSchemaTree } from "./treeStore"

/** The sidebar row that stands for a tab, and the nodes that must be expanded to show it. */
export interface RevealTarget {
  connectionId: ConnectionId
  /** Ancestors of the row, outermost first. */
  expand: readonly TreeKey[]
  /** The row itself; revealing never expands it. */
  row: TreeKey
}

const target = (connectionId: ConnectionId, path: readonly TreeKey[]): RevealTarget => ({
  connectionId,
  expand: path.slice(0, -1),
  row: path[path.length - 1],
})

/**
 * The row for `tab`: a query tab's database (the connection's current one when the tab has
 * none, the connection itself without either), a table tab's table, a DynamoDB tab's table.
 */
export function revealTarget(
  tab: WorkspaceTab | null,
  sessions: Readonly<Record<ConnectionId, MysqlSession>>,
  catalogs: Readonly<Record<ConnectionId, AthenaCatalog>>,
): RevealTarget | null {
  if (!tab) return null
  const id = tab.connectionId
  const root = connectionKey(id)
  switch (tab.kind) {
    case "table": {
      const db = databaseKey(id, tab.database)
      return target(id, [root, db, childKey(db, tab.table)])
    }
    case "dynamo":
      return target(id, tab.table === null ? [root] : [root, childKey(root, tab.table)])
    case "query": {
      const database =
        tab.engine === "athena"
          ? athenaTabDatabase(tab, catalogs[id])
          : tabDatabase(tab, sessions[id])
      return target(id, database === null ? [root] : [root, databaseKey(id, database)])
    }
  }
}

/** What decides how far a reveal may go without connecting. */
export interface GoalContext {
  /** The shortcut: it may connect (and prompt), like a click on the chevron. */
  focus: boolean
  /** Undefined while the connection isn't in the list. */
  kind: ConnectionConfig["kind"] | undefined
  /** The MySQL session's state; ignored for other kinds. */
  session: MysqlSessionState | undefined
  /** True when the connection sits in a collapsed folder, so its row isn't mounted. */
  folded: boolean
  tree: TreeState
}

/** True when mounting `key`'s children, or an expanded node under it, starts a load. */
function mountLoads(tree: TreeState, key: TreeKey): boolean {
  if (needsLoad(tree, key)) return true
  return Object.entries(tree.expanded).some(
    ([node, open]) => open && isDescendant(node, key) && needsLoad(tree, node),
  )
}

/**
 * How much of `found` to reveal. Following tabs never connects a MySQL session that isn't live
 * (a connect may ask for a password): the reveal stops above the first node that would mount a
 * load, counting the nodes already expanded below it, and is skipped when even un-collapsing
 * the folders around the connection would. Null reveals nothing.
 */
export function goalFor(found: RevealTarget, context: GoalContext): RevealTarget | null {
  const { focus, kind, session, folded, tree } = context
  if (focus) return found
  if (kind === undefined) return null
  if (kind !== "mysql" || isMysqlSessionLive(session)) return found
  const root = connectionKey(found.connectionId)
  if (folded && tree.expanded[root] && mountLoads(tree, root)) return null
  const index = found.expand.findIndex(
    (key) => needsLoad(tree, key) || (!tree.expanded[key] && mountLoads(tree, key)),
  )
  if (index === -1) return found
  return { ...found, expand: found.expand.slice(0, index), row: found.expand[index] }
}

/** Every node along the path whose filter text hides the next node, outermost first. */
export function hidingFilters(goal: RevealTarget, tree: TreeState): TreeKey[] {
  const path = [...goal.expand, goal.row]
  return goal.expand.filter((parent, index) => {
    const query = tree.filters[parent] ?? ""
    if (!query.trim()) return false
    const name = path[index + 1].slice(parent.length + 1)
    return filterChildren([{ name, kind: "table" }], query).length === 0
  })
}

/** A load as a reveal saw it when it started: an error of the same request counts only if it
 *  was still running then. */
interface LoadMark {
  requestId: number | undefined
  loading: boolean
}

/** What a reveal saw of its loads when it started, so an older failure doesn't end it. */
export interface LoadMarks {
  loads: Readonly<Record<TreeKey, LoadMark>>
  dynamoError: AppError | null
  dynamoLoading: boolean
}

type CatalogLoad = Pick<DynamoCatalog, "loading" | "error">

/** The DynamoDB table list counts only when the row sits under the connection. */
const dynamoFor = (goal: RevealTarget, dynamo: CatalogLoad | undefined) =>
  goal.expand.includes(connectionKey(goal.connectionId)) ? dynamo : undefined

export function markLoads(
  goal: RevealTarget,
  tree: TreeState,
  dynamo: CatalogLoad | undefined,
): LoadMarks {
  const catalog = dynamoFor(goal, dynamo)
  const mark = (key: TreeKey): LoadMark => ({
    requestId: tree.loads[key]?.requestId,
    loading: tree.loads[key]?.status === "loading",
  })
  return {
    loads: Object.fromEntries(goal.expand.map((key) => [key, mark(key)])),
    dynamoError: catalog?.error ?? null,
    dynamoLoading: catalog?.loading ?? false,
  }
}

/**
 * Whether a load the row waits on failed, is still running, or neither. Only a failure of a
 * request running or started after `marks` counts: a node mounted by the reveal retries an
 * older one.
 */
export function loadStatus(
  goal: RevealTarget,
  tree: TreeState,
  dynamo: CatalogLoad | undefined,
  marks: LoadMarks,
): "failed" | "loading" | "settled" {
  const catalog = dynamoFor(goal, dynamo)
  const failed = goal.expand.some((key) => {
    const load = tree.loads[key]
    const mark = marks.loads[key]
    return load?.status === "error" && (load.requestId !== mark?.requestId || mark.loading)
  })
  const dynamoFailed =
    catalog?.error != null && (catalog.error !== marks.dynamoError || marks.dynamoLoading)
  if (failed || dynamoFailed) return "failed"
  const loading = goal.expand.some((key) => tree.loads[key]?.status === "loading")
  return loading || catalog?.loading ? "loading" : "settled"
}

/** How long a reveal waits for its row once nothing it depends on is loading any more. */
const WAIT_MS = 3000

/** Bumped by every reveal, so a newer one cancels the one still waiting for its row. */
let current = 0

const tree = () => useSchemaTree.getState()

const dynamoCatalog = (id: ConnectionId) => useDynamoCatalog.getState().catalogs[id]

function activeTarget(): RevealTarget | null {
  return revealTarget(
    selectActiveTab(useTabsStore.getState()),
    useSessionsStore.getState().sessions,
    useAthenaStore.getState().catalogs,
  )
}

/** The goal for the active tab when following tabs, which never connects. */
function followGoal(found: RevealTarget): RevealTarget | null {
  const id = found.connectionId
  const layout = currentLayout()
  return goalFor(found, {
    focus: false,
    kind: useConnectionsStore.getState().byId(id)?.kind,
    session: useSessionsStore.getState().sessions[id]?.state,
    folded: expandFoldersAround(layout, id) !== layout,
    tree: tree(),
  })
}

function findRow(key: TreeKey): HTMLElement | null {
  // The sidebar's connection tree (`ConnectionList`) is the only place a reveal looks.
  const list = document.querySelector("[data-schema-tree]")
  if (!list) return null
  // Tree keys hold NUL characters, which an attribute selector can't match.
  const rows = list.querySelectorAll<HTMLElement>("[data-tree-key]")
  return [...rows].find((row) => row.dataset.treeKey === key) ?? null
}

function show(row: HTMLElement, key: TreeKey, focus: boolean): void {
  // A collapsed sidebar is zero wide; scrolling inside it would only shift it sideways.
  if (!useUiStore.getState().sidebarCollapsed) {
    ;(row.firstElementChild ?? row).scrollIntoView({ block: "nearest" })
  }
  tree().setFocused(key)
  if (focus) row.focus({ preventScroll: true })
}

/**
 * Expands everything above the row (folders included), waits for lazily loaded levels to
 * render it, scrolls it into view and makes it the tree's tab stop; `focus` also opens a
 * collapsed sidebar and moves focus to the row. When a load fails or the row never shows
 * (deleted, or hidden by the connection filter), the deepest ancestor that did render gets
 * the same treatment instead.
 */
function reveal(goal: RevealTarget, focus: boolean): void {
  const run = ++current
  const ui = useUiStore.getState()
  if (focus && ui.sidebarCollapsed) ui.toggleSidebar()
  useConnectionLayout.getState().update((layout) => expandFoldersAround(layout, goal.connectionId))
  for (const key of hidingFilters(goal, tree())) tree().setFilter(key, "")
  const marks = markLoads(goal, tree(), dynamoCatalog(goal.connectionId))
  tree().expandAll(goal.expand)

  // The sidebar stays inert until the render that opens it.
  const ready = (row: HTMLElement | null): row is HTMLElement =>
    row !== null && !(focus && row.closest("[inert]"))
  const fallBack = () => {
    const key = [...goal.expand].reverse().find((k) => ready(findRow(k)))
    const row = key === undefined ? null : findRow(key)
    if (key !== undefined && row) show(row, key, focus)
  }
  let deadline = performance.now() + WAIT_MS
  const step = () => {
    if (run !== current) return
    // A dialog (such as the password prompt) holds the window; look again once it closes.
    if (isModalOpen()) {
      deadline = performance.now() + WAIT_MS
      requestAnimationFrame(step)
      return
    }
    const status = loadStatus(goal, tree(), dynamoCatalog(goal.connectionId), marks)
    if (status === "failed") return fallBack()
    if (status === "loading") deadline = performance.now() + WAIT_MS
    const row = findRow(goal.row)
    if (ready(row)) return show(row, goal.row, focus)
    if (performance.now() < deadline) requestAnimationFrame(step)
    else fallBack()
  }
  step()
}

/** Mod+Shift+E: shows the active tab's row in the sidebar and focuses it. */
export function revealActiveTab(): void {
  const found = activeTarget()
  if (found) reveal(found, true)
}

const settled = (status: string) => status === "ready" || status === "error"

/**
 * While the setting is on, reveals the active tab (without taking focus or opening the
 * sidebar) whenever another tab becomes active, its database changes, or a session going live
 * lets a shortened reveal go further. Waits for the saved folder layout (whose changes are
 * ignored while it loads) and the connection list. `show` stands in for the DOM work in tests.
 * Returns the unsubscribe function.
 */
export function subscribeAutoReveal(
  show: (goal: RevealTarget) => void = (goal) => reveal(goal, false),
): () => void {
  let inputs: readonly unknown[] = []
  let last: string | null = null
  const check = () => {
    const layout = useConnectionLayout.getState()
    const connections = useConnectionsStore.getState()
    if (!settled(layout.status) || !settled(connections.status)) return
    const found = useSettingsStore.getState().settings.revealActiveTab ? activeTarget() : null
    const activeId = useTabsStore.getState().activeId
    const session = found && useSessionsStore.getState().sessions[found.connectionId]?.state
    // Most store events (schema loads, runs, typing) change none of what the goal depends on.
    const next = [found?.row, activeId, session, layout.layout, connections.connections]
    if (next.every((value, index) => value === inputs[index])) return
    inputs = next
    const goal = found && followGoal(found)
    const signature = found && `${activeId}\u0000${goal?.row ?? ""}`
    if (signature === last) return
    last = signature
    if (goal) show(goal)
  }
  const offs = [
    useSettingsStore.subscribe(check),
    useTabsStore.subscribe(check),
    useSessionsStore.subscribe(check),
    useAthenaStore.subscribe(check),
    useConnectionLayout.subscribe(check),
    useConnectionsStore.subscribe(check),
  ]
  check()
  return () => {
    for (const off of offs) off()
  }
}
