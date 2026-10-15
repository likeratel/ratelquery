import { create } from "zustand"
import { athenaApi } from "../lib/athena"
import {
  emptyAthenaCatalog,
  failDatabases,
  failSchema,
  finishDatabases,
  finishSchema,
  setCurrentDatabase,
  startDatabases,
  startSchema,
  type AthenaCatalog,
} from "../lib/athenaCatalog"
import type { ConnectionId } from "../lib/connections"
import { normalizeError, type AppError } from "../lib/ipc"

interface AthenaState {
  catalogs: Readonly<Record<ConnectionId, AthenaCatalog>>
  /**
   * Lists the databases once; `force` re-fetches. Concurrent callers share one request.
   * Resolves with the error (also kept in `lastError`) or null on success.
   */
  loadDatabases: (id: ConnectionId, force?: boolean) => Promise<AppError | null>
  /** Fetches (or re-fetches) the schema of `database`. Resolves with the error or null. */
  refreshSchema: (id: ConnectionId, database: string) => Promise<AppError | null>
  /** Loads the schema of `database` only when it isn't cached or loading yet. */
  ensureSchema: (id: ConnectionId, database: string | null) => Promise<void>
  setCurrentDatabase: (id: ConnectionId, database: string | null) => Promise<void>
  /** Drops the catalog of a deleted or edited connection; late responses are ignored. */
  forget: (id: ConnectionId) => void
}

const databasesInflight = new Map<ConnectionId, Promise<AppError | null>>()
const schemaInflight = new Map<string, Promise<AppError | null>>()

/**
 * Bumped by `forget`. Every request remembers the epoch it started in and drops its result
 * once the epoch moved on, so a response for a deleted (or re-pointed) connection can't
 * bring stale data back. Later requests start in the new epoch.
 */
const epochs = new Map<ConnectionId, number>()
const epochOf = (id: ConnectionId) => epochs.get(id) ?? 0

const schemaKey = (id: ConnectionId, database: string) => `${id}\u0000${database}`

/** Removes `key` only while it still maps to `request`, so a newer request stays tracked. */
const release = <K, V>(map: Map<K, V>, key: K, request: V) => {
  if (map.get(key) === request) map.delete(key)
}

const omit = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))

export const useAthenaStore = create<AthenaState>((set, get) => {
  const patch = (
    id: ConnectionId,
    update: (c: AthenaCatalog) => AthenaCatalog,
    epoch: number = epochOf(id),
  ) => {
    if (epochOf(id) !== epoch) return
    set((state) => ({
      catalogs: { ...state.catalogs, [id]: update(state.catalogs[id] ?? emptyAthenaCatalog()) },
    }))
  }

  const listDatabases = async (id: ConnectionId): Promise<AppError | null> => {
    const epoch = epochOf(id)
    patch(id, startDatabases, epoch)
    try {
      const databases = await athenaApi.databases(id)
      patch(id, (c) => finishDatabases(c, databases), epoch)
      return null
    } catch (raw) {
      const error = normalizeError(raw)
      patch(id, (c) => failDatabases(c, error), epoch)
      return error
    }
  }

  const fetchSchema = async (id: ConnectionId, database: string): Promise<AppError | null> => {
    const epoch = epochOf(id)
    patch(id, (c) => startSchema(c, database), epoch)
    try {
      const snapshot = await athenaApi.schema(id, database)
      patch(id, (c) => finishSchema(c, database, snapshot), epoch)
      return null
    } catch (raw) {
      const error = normalizeError(raw)
      patch(id, (c) => failSchema(c, database, error), epoch)
      return error
    }
  }

  return {
    catalogs: {},

    loadDatabases: (id, force = false) => {
      if (!force && get().catalogs[id]?.databases) return Promise.resolve(null)
      const pending = databasesInflight.get(id)
      if (pending) return pending
      const request: Promise<AppError | null> = listDatabases(id).finally(() =>
        release(databasesInflight, id, request),
      )
      databasesInflight.set(id, request)
      return request
    },

    refreshSchema: (id, database) => {
      const key = schemaKey(id, database)
      const pending = schemaInflight.get(key)
      if (pending) return pending
      const request: Promise<AppError | null> = fetchSchema(id, database).finally(() =>
        release(schemaInflight, key, request),
      )
      schemaInflight.set(key, request)
      return request
    },

    ensureSchema: async (id, database) => {
      if (!database || get().catalogs[id]?.schemas[database]) return
      await get().refreshSchema(id, database)
    },

    setCurrentDatabase: async (id, database) => {
      patch(id, (c) => setCurrentDatabase(c, database))
      await get().ensureSchema(id, database)
    },

    forget: (id) => {
      epochs.set(id, epochOf(id) + 1)
      databasesInflight.delete(id)
      for (const key of [...schemaInflight.keys()]) {
        if (key.startsWith(`${id}\u0000`)) schemaInflight.delete(key)
      }
      set((state) => ({ catalogs: omit(state.catalogs, id) }))
    },
  }
})
