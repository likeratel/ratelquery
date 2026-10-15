import { showToast } from "../../components/ui"
import type { ConnectionId } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import { normalizeError } from "../../lib/ipc"
import { mysqlApi } from "../../lib/mysql"
import { failTableLoad, finishTableLoad, startTableLoad, type TableTab } from "../../lib/queryTabs"
import { useSessionsStore } from "../../state/sessionsStore"
import { connectMysql, isPasswordCancelled } from "../connections/connectSession"
import { errorDetail } from "../connections/errors"
import { useTabsStore } from "../../state/tabsStore"
import { chooseTable, openDynamoTabFor } from "../dynamo"
import { useDynamoCatalog } from "../dynamo/catalogStore"
import { selectRowsSql } from "./sql"
import { connectionKey, databaseChildren, databaseKey, needsLoad, tableChildren } from "./treeState"
import { useSchemaTree } from "./treeStore"

const tree = () => useSchemaTree.getState()
const tabs = () => useTabsStore.getState()

/**
 * Connects the MySQL session when needed (asking for the password when none is stored); the
 * connection's default database is the fallback.
 */
function ensureSession(connectionId: ConnectionId) {
  return connectMysql(connectionId)
}

const session = (connectionId: ConnectionId) => useSessionsStore.getState().sessions[connectionId]

/**
 * Lists a MySQL connection's databases, connecting first. Skips a node that already loaded.
 * Goes through the session store, so the tree and the session share one list (and the request
 * the session starts on connect); without `force` a list the session already has is reused.
 */
export async function loadDatabases(connectionId: ConnectionId, force = false): Promise<void> {
  const key = connectionKey(connectionId)
  if (!force && !needsLoad(tree(), key)) return
  const requestId = tree().begin(key)
  try {
    await ensureSession(connectionId)
    if (force || !session(connectionId)?.databases.length) {
      const error = await useSessionsStore.getState().loadDatabases(connectionId)
      if (error) throw error
    }
    tree().resolve(key, requestId, databaseChildren(session(connectionId)?.databases ?? []))
  } catch (raw) {
    tree().reject(key, requestId, normalizeError(raw))
  }
}

/**
 * Lists the tables and views of one database. Reuses the session's cached schema snapshot
 * unless `force` asks for a fresh one; a fetch goes through the session store so the cache
 * (used by completion and editing) and the tree stay the same.
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
    if (force || !session(connectionId)?.schemas[database]) {
      await ensureSession(connectionId)
      const error = await useSessionsStore.getState().refreshSchema(connectionId, database)
      if (error) throw error
    }
    const snapshot = session(connectionId)?.schemas[database]
    tree().resolve(key, requestId, tableChildren(snapshot?.tables ?? []))
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
    if (isPasswordCancelled(raw)) return
    showToast({
      tone: "error",
      message: `Couldn't connect to select rows from ${table}`,
      detail: errorDetail(normalizeError(raw)),
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
    showToast({ tone: "success", message })
  } catch {
    showToast({ tone: "error", message: "Couldn't copy to the clipboard" })
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
