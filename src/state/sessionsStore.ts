import { listen } from "@tauri-apps/api/event"
import { create } from "zustand"
import type { ConnectionId } from "../lib/connections"
import { normalizeError, type AppError } from "../lib/ipc"
import {
  mysqlApi,
  type MysqlSessionInfo,
  type MysqlSessionState,
  type MysqlStateEvent,
  type SchemaSnapshot,
} from "../lib/mysql"

export const MYSQL_STATE_EVENT = "mysql:state"

export interface MysqlSession {
  state: MysqlSessionState
  serverVersion: string | null
  currentDatabase: string | null
  databases: readonly string[]
  /** Schema snapshots keyed by database name. */
  schemas: Readonly<Record<string, SchemaSnapshot>>
  schemaLoading: boolean
  lastError: AppError | null
  /** Increments each time the session recovers from a dropped connection. */
  reconnects: number
}

interface SessionsState {
  sessions: Readonly<Record<ConnectionId, MysqlSession>>
  /** Connects once; concurrent callers share the same in-flight request. */
  connect: (id: ConnectionId, fallbackDatabase?: string | null) => Promise<MysqlSessionInfo>
  loadDatabases: (id: ConnectionId) => Promise<void>
  /** Fetches (or re-fetches) the schema of `database`, defaulting to the current database. */
  refreshSchema: (id: ConnectionId, database?: string | null) => Promise<void>
  /** Loads the schema for `database` only when it isn't cached yet. */
  ensureSchema: (id: ConnectionId, database: string | null) => Promise<void>
  setCurrentDatabase: (id: ConnectionId, database: string | null) => Promise<void>
  applyStateEvent: (event: MysqlStateEvent) => void
  markReconnected: (id: ConnectionId) => void
  disconnect: (id: ConnectionId) => Promise<void>
}

export function emptySession(): MysqlSession {
  return {
    state: "disconnected",
    serverVersion: null,
    currentDatabase: null,
    databases: [],
    schemas: {},
    schemaLoading: false,
    lastError: null,
    reconnects: 0,
  }
}

/** Pure transition for a `mysql:state` event. Recovering from `reconnecting` counts as a reconnect. */
export function reduceStateEvent(session: MysqlSession, event: MysqlStateEvent): MysqlSession {
  const recovered = session.state === "reconnecting" && event.state === "connected"
  const lastError: AppError | null =
    event.state === "error"
      ? { kind: "connection", message: event.message ?? "Connection lost" }
      : event.state === "connected"
        ? null
        : session.lastError
  return {
    ...session,
    state: event.state,
    lastError,
    reconnects: recovered ? session.reconnects + 1 : session.reconnects,
  }
}

const inflight = new Map<ConnectionId, Promise<MysqlSessionInfo>>()

export const useSessionsStore = create<SessionsState>((set, get) => {
  const patch = (id: ConnectionId, update: (s: MysqlSession) => MysqlSession) =>
    set((state) => ({
      sessions: { ...state.sessions, [id]: update(state.sessions[id] ?? emptySession()) },
    }))

  const doConnect = async (id: ConnectionId, fallbackDatabase: string | null) => {
    patch(id, (s) => ({ ...s, state: "connecting", lastError: null }))
    try {
      const info = await mysqlApi.connect(id)
      const currentDatabase = info.currentDatabase ?? fallbackDatabase
      patch(id, (s) => ({
        ...s,
        state: "connected",
        serverVersion: info.serverVersion,
        currentDatabase,
        lastError: null,
      }))
      void get().loadDatabases(id)
      void get().ensureSchema(id, currentDatabase)
      return { ...info, currentDatabase }
    } catch (raw) {
      const error = normalizeError(raw)
      patch(id, (s) => ({ ...s, state: "error", lastError: error }))
      throw error
    }
  }

  return {
    sessions: {},

    connect: (id, fallbackDatabase = null) => {
      const session = get().sessions[id]
      if (session?.state === "connected" || session?.state === "reconnecting") {
        return Promise.resolve({
          serverVersion: session.serverVersion ?? "",
          currentDatabase: session.currentDatabase,
        })
      }
      const pending = inflight.get(id)
      if (pending) return pending
      const request = doConnect(id, fallbackDatabase).finally(() => inflight.delete(id))
      inflight.set(id, request)
      return request
    },

    loadDatabases: async (id) => {
      try {
        const databases = await mysqlApi.databases(id)
        patch(id, (s) => ({ ...s, databases }))
      } catch (raw) {
        patch(id, (s) => ({ ...s, lastError: normalizeError(raw) }))
      }
    },

    refreshSchema: async (id, database) => {
      const target = database ?? get().sessions[id]?.currentDatabase ?? null
      if (!target) return
      patch(id, (s) => ({ ...s, schemaLoading: true }))
      try {
        const snapshot = await mysqlApi.schema(id, target)
        patch(id, (s) => ({
          ...s,
          schemaLoading: false,
          schemas: { ...s.schemas, [target]: snapshot },
        }))
      } catch (raw) {
        patch(id, (s) => ({ ...s, schemaLoading: false, lastError: normalizeError(raw) }))
      }
    },

    ensureSchema: async (id, database) => {
      if (!database || get().sessions[id]?.schemas[database]) return
      await get().refreshSchema(id, database)
    },

    setCurrentDatabase: async (id, database) => {
      patch(id, (s) => ({ ...s, currentDatabase: database }))
      await get().ensureSchema(id, database)
    },

    applyStateEvent: (event) => patch(event.connectionId, (s) => reduceStateEvent(s, event)),

    markReconnected: (id) => patch(id, (s) => ({ ...s, reconnects: s.reconnects + 1 })),

    disconnect: async (id) => {
      await mysqlApi.disconnect(id)
      patch(id, () => emptySession())
    },
  }
})

const SESSION_STATES: ReadonlySet<string> = new Set<MysqlSessionState>([
  "connecting",
  "connected",
  "reconnecting",
  "disconnected",
  "error",
])

/** Validates an event payload from the backend before it touches the store. */
export function isStateEvent(value: unknown): value is MysqlStateEvent {
  if (typeof value !== "object" || value === null) return false
  const { connectionId, state, message } = value as Record<string, unknown>
  return (
    typeof connectionId === "string" &&
    typeof state === "string" &&
    SESSION_STATES.has(state) &&
    (message === undefined || message === null || typeof message === "string")
  )
}

/**
 * Subscribes the store to backend `mysql:state` events. Returns an unsubscribe function.
 * Outside Tauri (plain browser) `listen` rejects; the subscription is then a no-op.
 */
export function subscribeSessionEvents(): () => void {
  let unlisten: (() => void) | null = null
  let disposed = false
  listen<unknown>(MYSQL_STATE_EVENT, (event) => {
    if (isStateEvent(event.payload)) useSessionsStore.getState().applyStateEvent(event.payload)
  })
    .then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    .catch(() => {
      /* No Tauri runtime: there are no backend events to receive. */
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}
