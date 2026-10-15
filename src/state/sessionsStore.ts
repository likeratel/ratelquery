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
  /** Databases whose schema is being fetched right now. */
  schemaLoading: Readonly<Record<string, boolean>>
  lastError: AppError | null
  /** Increments each time the session recovers from a dropped connection. */
  reconnects: number
  /**
   * The last counted recovery and who reported it. A query retry is reported twice, once by the
   * `reconnecting -> connected` event and once by the result's `reconnected` flag, in either
   * order; the second report within `RECONNECT_DEDUPE_MS` is the same recovery.
   */
  lastRecovery: { source: RecoverySource; at: number } | null
}

export type RecoverySource = "event" | "result"

/** Window in which an event and a result flag describe the same recovery. */
export const RECONNECT_DEDUPE_MS = 5000

interface SessionsState {
  sessions: Readonly<Record<ConnectionId, MysqlSession>>
  /**
   * Connects once; concurrent callers share the same in-flight request. A `secret` is used for
   * this session only (nothing is stored).
   */
  connect: (
    id: ConnectionId,
    fallbackDatabase?: string | null,
    secret?: string,
  ) => Promise<MysqlSessionInfo>
  /**
   * Lists the databases into the session; concurrent callers share the request in flight.
   * Resolves with the error (also kept in `lastError`) or null on success.
   */
  loadDatabases: (id: ConnectionId) => Promise<AppError | null>
  /**
   * Fetches (or re-fetches) the schema of `database`, defaulting to the current database.
   * Resolves with the error (also kept in `lastError`) or null on success.
   */
  refreshSchema: (id: ConnectionId, database?: string | null) => Promise<AppError | null>
  /** Loads the schema for `database` only when it isn't cached yet. */
  ensureSchema: (id: ConnectionId, database: string | null) => Promise<void>
  setCurrentDatabase: (id: ConnectionId, database: string | null) => Promise<void>
  applyStateEvent: (event: MysqlStateEvent) => void
  /** Called when a query result reports `reconnected`; counted once per recovery. */
  markReconnected: (id: ConnectionId) => void
  /** Drops local state for a deleted connection; the backend already closed its session. */
  forget: (id: ConnectionId) => void
}

export function emptySession(): MysqlSession {
  return {
    state: "disconnected",
    serverVersion: null,
    currentDatabase: null,
    databases: [],
    schemas: {},
    schemaLoading: {},
    lastError: null,
    reconnects: 0,
    lastRecovery: null,
  }
}

/** True while the schema of `database` is being fetched. */
export function isSchemaLoading(session: MysqlSession | undefined, database: string | null) {
  return Boolean(database && session?.schemaLoading[database])
}

/**
 * Counts one recovery reported by `source`. A report from the other source shortly after the
 * last counted one is the same recovery and only clears the marker.
 */
export function noteRecovery(
  session: MysqlSession,
  source: RecoverySource,
  now: number,
): MysqlSession {
  const last = session.lastRecovery
  if (last && last.source !== source && now - last.at <= RECONNECT_DEDUPE_MS) {
    return { ...session, lastRecovery: null }
  }
  return { ...session, reconnects: session.reconnects + 1, lastRecovery: { source, at: now } }
}

/** Pure transition for a `mysql:state` event. Recovering from `reconnecting` counts as a reconnect. */
export function reduceStateEvent(
  session: MysqlSession,
  event: MysqlStateEvent,
  now: number = Date.now(),
): MysqlSession {
  const recovered = session.state === "reconnecting" && event.state === "connected"
  const lastError: AppError | null =
    event.state === "error"
      ? { kind: "connection", message: event.message ?? "Connection lost" }
      : event.state === "connected"
        ? null
        : session.lastError
  const next = { ...session, state: event.state, lastError }
  return recovered ? noteRecovery(next, "event", now) : next
}

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))

const inflight = new Map<ConnectionId, Promise<MysqlSessionInfo>>()
const databasesInflight = new Map<ConnectionId, Promise<AppError | null>>()

/**
 * Deleted connections. Responses and events that arrive after `forget` must not bring the
 * session back, so async work remembers the epoch it started in and drops its result once the
 * epoch moved on. Only an explicit `connect` takes a connection off the forgotten list again.
 */
const forgotten = new Set<ConnectionId>()
const epochs = new Map<ConnectionId, number>()
const epochOf = (id: ConnectionId) => epochs.get(id) ?? 0

export const useSessionsStore = create<SessionsState>((set, get) => {
  /** Applies `update` unless the connection was forgotten since `epoch`. */
  const patch = (
    id: ConnectionId,
    update: (s: MysqlSession) => MysqlSession,
    epoch: number = epochOf(id),
  ) => {
    if (forgotten.has(id) || epochOf(id) !== epoch) return
    set((state) => ({
      sessions: { ...state.sessions, [id]: update(state.sessions[id] ?? emptySession()) },
    }))
  }

  const doConnect = async (
    id: ConnectionId,
    fallbackDatabase: string | null,
    secret: string | undefined,
  ) => {
    const epoch = epochOf(id)
    patch(id, (s) => ({ ...s, state: "connecting", lastError: null }), epoch)
    try {
      const info = await mysqlApi.connect(id, secret)
      const currentDatabase = info.currentDatabase ?? fallbackDatabase
      if (epochOf(id) !== epoch) return { ...info, currentDatabase }
      patch(
        id,
        (s) => ({
          ...s,
          state: "connected",
          serverVersion: info.serverVersion,
          currentDatabase,
          lastError: null,
        }),
        epoch,
      )
      void get().loadDatabases(id)
      void get().ensureSchema(id, currentDatabase)
      return { ...info, currentDatabase }
    } catch (raw) {
      const error = normalizeError(raw)
      patch(id, (s) => ({ ...s, state: "error", lastError: error }), epoch)
      throw error
    }
  }

  return {
    sessions: {},

    connect: (id, fallbackDatabase = null, secret) => {
      forgotten.delete(id)
      const session = get().sessions[id]
      if (session?.state === "connected" || session?.state === "reconnecting") {
        return Promise.resolve({
          serverVersion: session.serverVersion ?? "",
          currentDatabase: session.currentDatabase,
        })
      }
      const pending = inflight.get(id)
      if (pending) return pending
      const request: Promise<MysqlSessionInfo> = doConnect(id, fallbackDatabase, secret).finally(
        () => {
          if (inflight.get(id) === request) inflight.delete(id)
        },
      )
      inflight.set(id, request)
      return request
    },

    loadDatabases: (id) => {
      const pending = databasesInflight.get(id)
      if (pending) return pending
      const epoch = epochOf(id)
      const request = mysqlApi
        .databases(id)
        .then((databases) => {
          patch(id, (s) => ({ ...s, databases }), epoch)
          return null
        })
        .catch((raw: unknown) => {
          const error = normalizeError(raw)
          patch(id, (s) => ({ ...s, lastError: error }), epoch)
          return error
        })
        .finally(() => {
          if (databasesInflight.get(id) === request) databasesInflight.delete(id)
        })
      databasesInflight.set(id, request)
      return request
    },

    refreshSchema: async (id, database) => {
      const target = database ?? get().sessions[id]?.currentDatabase ?? null
      if (!target) return null
      const epoch = epochOf(id)
      patch(id, (s) => ({ ...s, schemaLoading: { ...s.schemaLoading, [target]: true } }), epoch)
      try {
        const snapshot = await mysqlApi.schema(id, target)
        patch(
          id,
          (s) => ({
            ...s,
            schemaLoading: withoutKey(s.schemaLoading, target),
            schemas: { ...s.schemas, [target]: snapshot },
          }),
          epoch,
        )
        return null
      } catch (raw) {
        const error = normalizeError(raw)
        patch(
          id,
          (s) => ({
            ...s,
            schemaLoading: withoutKey(s.schemaLoading, target),
            lastError: error,
          }),
          epoch,
        )
        return error
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

    markReconnected: (id) => patch(id, (s) => noteRecovery(s, "result", Date.now())),

    forget: (id) => {
      forgotten.add(id)
      epochs.set(id, epochOf(id) + 1)
      inflight.delete(id)
      databasesInflight.delete(id)
      set((state) => ({ sessions: withoutKey(state.sessions, id) }))
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
