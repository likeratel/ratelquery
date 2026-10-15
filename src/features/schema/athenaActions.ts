import { athenaSelectRowsSql } from "../../lib/athenaSql"
import type { ConnectionId } from "../../lib/connections"
import { normalizeError } from "../../lib/ipc"
import { useAthenaStore } from "../../state/athenaStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { openAthenaTab } from "../query/actions"
import { selectRowsLimit } from "./sql"
import { connectionKey, databaseChildren, databaseKey, needsLoad, tableChildren } from "./treeState"
import { useSchemaTree } from "./treeStore"

const tree = () => useSchemaTree.getState()
const athena = () => useAthenaStore.getState()

/**
 * Lists an Athena connection's databases into the tree through the catalog store, so the tree,
 * the database picker and completion share one list. Skips a node that already loaded.
 */
export async function loadAthenaDatabases(connectionId: ConnectionId, force = false) {
  const key = connectionKey(connectionId)
  if (!force && !needsLoad(tree(), key)) return
  const requestId = tree().begin(key)
  const error = await athena().loadDatabases(connectionId, force)
  if (error) {
    tree().reject(key, requestId, error)
    return
  }
  const databases = athena().catalogs[connectionId]?.databases ?? []
  tree().resolve(key, requestId, databaseChildren(databases))
}

/** Lists the tables and views of one database, reusing the cached snapshot unless `force`. */
export async function loadAthenaTables(
  connectionId: ConnectionId,
  database: string,
  force = false,
) {
  const key = databaseKey(connectionId, database)
  if (!force && !needsLoad(tree(), key)) return
  const requestId = tree().begin(key)
  try {
    if (force || !athena().catalogs[connectionId]?.schemas[database]) {
      const error = await athena().refreshSchema(connectionId, database)
      if (error) throw error
    }
    const snapshot = athena().catalogs[connectionId]?.schemas[database]
    tree().resolve(key, requestId, tableChildren(snapshot?.tables ?? []))
  } catch (raw) {
    tree().reject(key, requestId, normalizeError(raw))
  }
}

/**
 * Opens an Athena query tab on the table's database with `SELECT * ... LIMIT n` in the editor.
 * It doesn't run: every Athena statement is billed, so the user starts it.
 */
export function queryAthenaTable(connectionId: ConnectionId, database: string, table: string) {
  const config = useConnectionsStore.getState().byId(connectionId)
  if (config?.kind !== "athena") return
  const id = openAthenaTab(config, database)
  useTabsStore.getState().setSql(id, athenaSelectRowsSql(database, table, selectRowsLimit()))
}
