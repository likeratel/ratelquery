/**
 * Connects completion to the Athena catalog store: the catalog is read fresh on every request,
 * and a missing schema is fetched once no matter how many keystrokes ask for it.
 */

import type { ConnectionId } from "../../../lib/connections"
import type { SchemaSnapshot } from "../../../lib/mysql"
import { ATHENA_DIALECT } from "../../../lib/sqlDialect"
import { useAthenaStore } from "../../../state/athenaStore"
import type { SchemaCatalog } from "./catalog"
import { SCHEMA_RETRY_MS } from "./sessionEnv"
import type { CompletionEnv } from "./source"

type AthenaStore = Pick<typeof useAthenaStore, "getState">

const NO_DATABASES: readonly string[] = []
const NO_SCHEMAS: Readonly<Record<string, SchemaSnapshot>> = {}

/** Deduplicated schema loads shared by every Athena editor using the same store. */
export function createAthenaSchemaRequests(store: AthenaStore, now: () => number = Date.now) {
  const inflight = new Map<string, Promise<void>>()
  const failedAt = new Map<string, number>()

  return (connectionId: ConnectionId, database: string): Promise<void> | null => {
    const catalog = store.getState().catalogs[connectionId]
    if (catalog?.schemas[database]) return null
    // A name that isn't a known database would only come back as `not_found`.
    if (catalog?.databases && !catalog.databases.includes(database)) return null
    const key = `${connectionId}\u0000${database}`
    const pending = inflight.get(key)
    if (pending) return pending
    const failed = failedAt.get(key)
    if (failed !== undefined && now() - failed < SCHEMA_RETRY_MS) return null
    const request = store
      .getState()
      .refreshSchema(connectionId, database)
      .then((error) => {
        if (error) failedAt.set(key, now())
        else failedAt.delete(key)
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, request)
    return request
  }
}

const sharedRequests = createAthenaSchemaRequests(useAthenaStore)

/** Completion env for an Athena editor on `connectionId` whose statements run in `database`. */
export function createAthenaCompletionEnv(
  connectionId: ConnectionId,
  database: string | null,
  store: AthenaStore = useAthenaStore,
  requestSchema: ReturnType<typeof createAthenaSchemaRequests> = store === useAthenaStore
    ? sharedRequests
    : createAthenaSchemaRequests(store),
): CompletionEnv {
  return {
    dialect: ATHENA_DIALECT,
    catalog: (): SchemaCatalog => {
      const catalog = store.getState().catalogs[connectionId]
      return {
        currentDatabase: database,
        databases: catalog?.databases ?? NO_DATABASES,
        schemas: catalog?.schemas ?? NO_SCHEMAS,
      }
    },
    requestSchema: (name) => requestSchema(connectionId, name),
  }
}
