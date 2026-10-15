import { create } from "zustand"
import type { ConnectionId } from "../../lib/connections"
import { dynamoApi, type TableDescription } from "../../lib/dynamo"
import { normalizeError, type AppError } from "../../lib/ipc"

/** Table names and descriptions for one DynamoDB connection, shared by all its tabs. */
export interface DynamoCatalog {
  tables: readonly string[] | null
  loading: boolean
  error: AppError | null
  descriptions: Readonly<Record<string, TableDescription>>
  describing: Readonly<Record<string, boolean>>
  describeErrors: Readonly<Record<string, AppError>>
}

interface CatalogState {
  catalogs: Readonly<Record<ConnectionId, DynamoCatalog>>
  /** Lists tables once; `force` re-fetches. Concurrent callers share one request. */
  loadTables: (id: ConnectionId, force?: boolean) => Promise<void>
  /** Describes a table once; `force` re-fetches. */
  describe: (id: ConnectionId, table: string, force?: boolean) => Promise<TableDescription | null>
  /** Drops the cached catalog of a deleted connection. */
  forget: (id: ConnectionId) => void
}

export function emptyCatalog(): DynamoCatalog {
  return {
    tables: null,
    loading: false,
    error: null,
    descriptions: {},
    describing: {},
    describeErrors: {},
  }
}

const listing = new Map<ConnectionId, Promise<void>>()
const describing = new Map<string, Promise<TableDescription | null>>()

const omit = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))

export const useDynamoCatalog = create<CatalogState>((set, get) => {
  const patch = (id: ConnectionId, update: (c: DynamoCatalog) => DynamoCatalog) =>
    set((state) => ({
      catalogs: { ...state.catalogs, [id]: update(state.catalogs[id] ?? emptyCatalog()) },
    }))

  const doList = async (id: ConnectionId) => {
    patch(id, (c) => ({ ...c, loading: true, error: null }))
    try {
      const tables = await dynamoApi.listTables(id)
      patch(id, (c) => ({ ...c, loading: false, tables: [...tables].sort() }))
    } catch (raw) {
      patch(id, (c) => ({ ...c, loading: false, error: normalizeError(raw) }))
    }
  }

  const doDescribe = async (id: ConnectionId, table: string) => {
    patch(id, (c) => ({
      ...c,
      describing: { ...c.describing, [table]: true },
      describeErrors: omit(c.describeErrors, table),
    }))
    try {
      const description = await dynamoApi.describeTable(id, table)
      patch(id, (c) => ({
        ...c,
        describing: omit(c.describing, table),
        descriptions: { ...c.descriptions, [table]: description },
      }))
      return description
    } catch (raw) {
      const error = normalizeError(raw)
      patch(id, (c) => ({
        ...c,
        describing: omit(c.describing, table),
        describeErrors: { ...c.describeErrors, [table]: error },
      }))
      return null
    }
  }

  return {
    catalogs: {},

    loadTables: (id, force = false) => {
      const catalog = get().catalogs[id]
      if (!force && catalog?.tables) return Promise.resolve()
      const pending = listing.get(id)
      if (pending) return pending
      const request = doList(id).finally(() => listing.delete(id))
      listing.set(id, request)
      return request
    },

    describe: (id, table, force = false) => {
      const cached = get().catalogs[id]?.descriptions[table]
      if (!force && cached) return Promise.resolve(cached)
      const key = `${id}\u0000${table}`
      const pending = describing.get(key)
      if (pending) return pending
      const request = doDescribe(id, table).finally(() => describing.delete(key))
      describing.set(key, request)
      return request
    },

    forget: (id) => {
      listing.delete(id)
      for (const key of [...describing.keys()]) {
        if (key.startsWith(`${id}\u0000`)) describing.delete(key)
      }
      set((state) => ({ catalogs: omit(state.catalogs, id) }))
    },
  }
})

export function descriptionFor(
  connectionId: ConnectionId,
  table: string | null,
): TableDescription | null {
  if (!table) return null
  return useDynamoCatalog.getState().catalogs[connectionId]?.descriptions[table] ?? null
}
