/**
 * Connects completion to the sessions store: the catalog is read fresh on every request, and a
 * missing schema is fetched once (`ensureSchema`) no matter how many keystrokes ask for it.
 */

import type { ConnectionId } from "../../../lib/connections"
import type { SchemaSnapshot } from "../../../lib/mysql"
import { useSessionsStore } from "../../../state/sessionsStore"
import type { SchemaCatalog } from "./catalog"
import type { CompletionEnv } from "./source"

/** A failed schema fetch is not retried from completion for this long. */
export const SCHEMA_RETRY_MS = 30_000

type SessionsStore = Pick<typeof useSessionsStore, "getState" | "subscribe">

const NO_DATABASES: readonly string[] = []
const NO_SCHEMAS: Readonly<Record<string, SchemaSnapshot>> = {}

/** Resolves once `database` of `connectionId` is no longer loading. */
function untilLoaded(store: SessionsStore, connectionId: ConnectionId, database: string) {
  return new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe((state) => {
      if (state.sessions[connectionId]?.schemaLoading[database]) return
      unsubscribe()
      resolve()
    })
  })
}

/** Deduplicated schema loads shared by every editor using the same store. */
export function createSchemaRequests(store: SessionsStore, now: () => number = Date.now) {
  const inflight = new Map<string, Promise<void>>()
  const failedAt = new Map<string, number>()

  return (connectionId: ConnectionId, database: string): Promise<void> | null => {
    const session = store.getState().sessions[connectionId]
    if (!session || session.state !== "connected" || session.schemas[database]) return null
    const key = `${connectionId}\u0000${database}`
    const pending = inflight.get(key)
    if (pending) return pending
    const failed = failedAt.get(key)
    if (failed !== undefined && now() - failed < SCHEMA_RETRY_MS) return null
    const load = session.schemaLoading[database]
      ? untilLoaded(store, connectionId, database)
      : store.getState().ensureSchema(connectionId, database)
    const request = load
      .then(() => {
        if (store.getState().sessions[connectionId]?.schemas[database]) failedAt.delete(key)
        else failedAt.set(key, now())
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, request)
    return request
  }
}

const sharedRequests = createSchemaRequests(useSessionsStore)

/** Completion env for an editor on `connectionId` whose statements run in `database`. */
export function createSessionCompletionEnv(
  connectionId: ConnectionId,
  database: string | null,
  store: SessionsStore = useSessionsStore,
  requestSchema: ReturnType<typeof createSchemaRequests> = store === useSessionsStore
    ? sharedRequests
    : createSchemaRequests(store),
): CompletionEnv {
  return {
    catalog: (): SchemaCatalog => {
      const session = store.getState().sessions[connectionId]
      return {
        currentDatabase: database,
        databases: session?.databases ?? NO_DATABASES,
        schemas: session?.schemas ?? NO_SCHEMAS,
      }
    },
    requestSchema: (name) => requestSchema(connectionId, name),
  }
}
