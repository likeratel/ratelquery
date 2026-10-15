import { showToast } from "../../components/ui"
import type { ConnectionId } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import { normalizeError } from "../../lib/ipc"
import { mysqlApi } from "../../lib/mysql"
import { failTableLoad, finishTableLoad, startTableLoad, type TableTab } from "../../lib/queryTabs"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { chooseTable, openDynamoTabFor } from "../dynamo"
import { useDynamoCatalog } from "../dynamo/catalogStore"
import { toast } from "../query"
import { selectRowsSql } from "./sql"
import { connectionKey, databaseChildren, databaseKey, needsLoad, tableChildren } from "./treeState"
import { useSchemaTree } from "./treeStore"

const tree = () => useSchemaTree.getState()
const tabs = () => useTabsStore.getState()

/** Connects the MySQL session when needed; the connection's default database is the fallback. */
function ensureSession(connectionId: ConnectionId) {
  const config = useConnectionsStore.getState().byId(connectionId)
  const fallback = config?.kind === "mysql" ? (config.database ?? null) : null
  return useSessionsStore.getState().connect(connectionId, fallback)
}

/** Lists a MySQL connection's databases, connecting first. Skips a node that already loaded. */
export async function loadDatabases(connectionId: ConnectionId, force = false): Promise<void> {
  const key = connectionKey(connectionId)
  if (!force && !needsLoad(tree(), key)) return
  const requestId = tree().begin(key)
  try {
    await ensureSession(connectionId)
    const names = await mysqlApi.databases(connectionId)
    tree().resolve(key, requestId, databaseChildren(names))
  } catch (raw) {
    tree().reject(key, requestId, normalizeError(raw))
  }
}

/**
 * Lists the tables and views of one database. Reuses the session's cached schema snapshot
 * unless `force` asks for a fresh one.
 */
export async function loadTables(
  connectionId: ConnectionId,
  database: string,
  force = false,
): Promise<void> {
  const key = databaseKey(connectionId, database)
  if (!force && !needsLoad(tree(), key)) return
  const requestId = tree().begin(key)
  try {
    const cached = force
      ? undefined
      : useSessionsStore.getState().sessions[connectionId]?.schemas[database]
    if (!cached) await ensureSession(connectionId)
    const snapshot = cached ?? (await mysqlApi.schema(connectionId, database))
    tree().resolve(key, requestId, tableChildren(snapshot.tables))
  } catch (raw) {
    tree().reject(key, requestId, normalizeError(raw))
  }
}

function findTableTabById(id: string): TableTab | null {
  const tab = tabs().tabs.find((t) => t.id === id)
  return tab?.kind === "table" ? tab : null
}

/** In-flight details requests by tab id, so concurrent callers share one. */
const detailRequests = new Map<string, Promise<void>>()

/**
 * Fetches `mysql_table_details` into the tab. Without `force` it reuses the cached response
 * (or the last error, until the user refreshes); a request already in flight is shared.
 */
export function loadTableDetails(tabId: string, force = false): Promise<void> {
  const tab = findTableTabById(tabId)
  if (!tab) return Promise.resolve()
  const pending = detailRequests.get(tabId)
  if (!force && pending) return pending
  if (!force && (tab.details || tab.error)) return Promise.resolve()
  const request = fetchDetails(tab).finally(() => {
    if (detailRequests.get(tabId) === request) detailRequests.delete(tabId)
  })
  detailRequests.set(tabId, request)
  return request
}

async function fetchDetails(tab: TableTab): Promise<void> {
  tabs().updateTable(tab.id, startTableLoad)
  const requestId = findTableTabById(tab.id)?.requestId ?? 0
  try {
    await ensureSession(tab.connectionId)
    const details = await mysqlApi.tableDetails(tab.connectionId, tab.database, tab.table)
    tabs().updateTable(tab.id, (t) => finishTableLoad(t, requestId, details))
  } catch (raw) {
    const error = normalizeError(raw)
    tabs().updateTable(tab.id, (t) => failTableLoad(t, requestId, error))
  }
}

/** Opens (or activates) the table's structure tab and loads its details once. */
export function openTable(connectionId: ConnectionId, database: string, table: string): string {
  const id = tabs().openTable(connectionId, database, table)
  void loadTableDetails(id)
  return id
}

/** Opens a query tab on the table's database with `SELECT * ... LIMIT n` and runs it. */
export async function selectRows(
  connectionId: ConnectionId,
  database: string,
  table: string,
): Promise<void> {
  try {
    await ensureSession(connectionId)
  } catch (raw) {
    showToast({
      tone: "error",
      message: `Could not connect to select rows from ${table}.`,
      detail: normalizeError(raw).message,
    })
    return
  }
  const id = tabs().open(connectionId, database)
  tabs().setSql(id, selectRowsSql(table))
  // A failed run shows its error in the new tab.
  await tabs().run(id)
}

/** Re-reads a table: its database's table list and, when its tab is open, its details. */
export async function refreshTable(
  connectionId: ConnectionId,
  database: string,
  table: string,
): Promise<void> {
  const open = tabs().tabs.find(
    (t) =>
      t.kind === "table" &&
      t.connectionId === connectionId &&
      t.database === database &&
      t.table === table,
  )
  await Promise.all([
    loadTables(connectionId, database, true),
    open ? loadTableDetails(open.id, true) : Promise.resolve(),
  ])
}

/** Copies text to the clipboard and confirms with `message`. */
export async function copyText(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(message, "success")
  } catch {
    toast("Couldn't copy to the clipboard", "danger")
  }
}

export const copyName = (name: string) => copyText(name, "Copied name")

/** Shows a DynamoDB table: activates a tab already on it, else opens one and selects it. */
export async function openDynamoTable(connectionId: ConnectionId, table: string): Promise<void> {
  const existing = tabs().tabs.find(
    (t) => t.kind === "dynamo" && t.connectionId === connectionId && t.table === table,
  )
  if (existing) {
    tabs().activate(existing.id)
    return
  }
  const id = openDynamoTabFor(connectionId)
  await chooseTable(id, table)
}

export function refreshDynamoTables(connectionId: ConnectionId): Promise<void> {
  return useDynamoCatalog.getState().loadTables(connectionId, true)
}

/** Drops tree state of deleted connections. Returns the unsubscribe function. */
export function subscribeTreeCleanup(): () => void {
  return onAppEvent("connection-removed", (id) => tree().forget(id))
}
