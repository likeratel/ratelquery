import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport } from "../lib/ipc"
import type { SchemaSnapshot } from "../lib/mysql"
import {
  emptySession,
  isSchemaLoading,
  isStateEvent,
  noteRecovery,
  RECONNECT_DEDUPE_MS,
  reduceStateEvent,
  useSessionsStore,
} from "./sessionsStore"

interface Call {
  command: string
  args?: Record<string, unknown>
}

const snapshot = (database: string): SchemaSnapshot => ({
  database,
  tables: [],
  fetchedAt: "2026-01-01T00:00:00Z",
})

/** Fake backend: answers like the real commands and records every call. */
function fakeBackend(overrides: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = []
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    mysql_connect: () => ({ serverVersion: "8.4.0", currentDatabase: "app" }),
    mysql_databases: () => ["app", "shop"],
    mysql_schema: (args) => snapshot(String(args?.database)),
    ...overrides,
  }
  const restore = setTransport(async (command, args) => {
    calls.push({ command, args })
    const handler = handlers[command]
    if (!handler) throw { kind: "not_found", message: `no fake for ${command}` }
    return handler(args)
  })
  return { calls, restore }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let restore: () => void = () => {}

beforeEach(() => useSessionsStore.setState({ sessions: {} }))
afterEach(() => restore())

describe("connect", () => {
  it("stores session info, then loads databases and the current schema", async () => {
    const backend = fakeBackend()
    restore = backend.restore
    const info = await useSessionsStore.getState().connect("c1")
    await flush()
    expect(info).toEqual({ serverVersion: "8.4.0", currentDatabase: "app" })
    const session = useSessionsStore.getState().sessions.c1
    expect(session).toMatchObject({
      state: "connected",
      serverVersion: "8.4.0",
      currentDatabase: "app",
      databases: ["app", "shop"],
    })
    expect(session.schemas.app?.database).toBe("app")
  })

  it("shares one request between concurrent callers and skips connected sessions", async () => {
    const backend = fakeBackend()
    restore = backend.restore
    const store = useSessionsStore.getState()
    await Promise.all([store.connect("c1"), store.connect("c1")])
    await store.connect("c1")
    expect(backend.calls.filter((c) => c.command === "mysql_connect")).toHaveLength(1)
  })

  it("falls back to the configured database when the server reports none", async () => {
    const backend = fakeBackend({
      mysql_connect: () => ({ serverVersion: "8", currentDatabase: null }),
    })
    restore = backend.restore
    const info = await useSessionsStore.getState().connect("c1", "shop")
    expect(info.currentDatabase).toBe("shop")
  })

  it("records the error and rethrows it as an AppError", async () => {
    const backend = fakeBackend({
      mysql_connect: () => {
        throw { kind: "connection", message: "refused" }
      },
    })
    restore = backend.restore
    await expect(useSessionsStore.getState().connect("c1")).rejects.toEqual({
      kind: "connection",
      message: "refused",
    })
    expect(useSessionsStore.getState().sessions.c1).toMatchObject({
      state: "error",
      lastError: { kind: "connection", message: "refused" },
    })
  })
})

describe("schema", () => {
  it("switches database, caches schemas and refreshes on demand", async () => {
    const backend = fakeBackend()
    restore = backend.restore
    const store = useSessionsStore.getState()
    await store.connect("c1")
    await flush()
    await store.setCurrentDatabase("c1", "shop")
    await store.setCurrentDatabase("c1", "shop")
    const schemaCalls = () => backend.calls.filter((c) => c.command === "mysql_schema")
    expect(schemaCalls().map((c) => c.args?.database)).toEqual(["app", "shop"])
    await store.refreshSchema("c1")
    expect(schemaCalls()).toHaveLength(3)
    expect(useSessionsStore.getState().sessions.c1.currentDatabase).toBe("shop")
  })

  it("tracks loading per database, so one slow schema doesn't block another", async () => {
    const pending: Record<string, (value: SchemaSnapshot) => void> = {}
    const backend = fakeBackend({
      mysql_schema: (args) =>
        new Promise((resolve) => {
          pending[String(args?.database)] = resolve
        }),
    })
    restore = backend.restore
    useSessionsStore.setState({ sessions: { c1: { ...emptySession(), state: "connected" } } })
    const store = useSessionsStore.getState()
    const app = store.refreshSchema("c1", "app")
    const shop = store.refreshSchema("c1", "shop")
    await flush()
    pending.shop(snapshot("shop"))
    await shop
    const session = useSessionsStore.getState().sessions.c1
    expect(isSchemaLoading(session, "app")).toBe(true)
    expect(isSchemaLoading(session, "shop")).toBe(false)
    pending.app(snapshot("app"))
    await app
    expect(useSessionsStore.getState().sessions.c1.schemaLoading).toEqual({})
  })
})

describe("forget", () => {
  it("drops the session of a deleted connection only", () => {
    useSessionsStore.setState({ sessions: { c1: emptySession(), c2: emptySession() } })
    useSessionsStore.getState().forget("c1")
    expect(Object.keys(useSessionsStore.getState().sessions)).toEqual(["c2"])
  })

  it("ignores responses and events that arrive after the connection is deleted", async () => {
    let answer: (info: unknown) => void = () => {}
    const backend = fakeBackend({
      mysql_connect: () => new Promise((resolve) => (answer = resolve)),
    })
    restore = backend.restore
    const store = useSessionsStore.getState()
    const connecting = store.connect("gone")
    await flush()
    store.forget("gone")
    answer({ serverVersion: "8", currentDatabase: "app" })
    await connecting
    await flush()
    store.applyStateEvent({ connectionId: "gone", state: "disconnected" })
    store.markReconnected("gone")
    expect(useSessionsStore.getState().sessions.gone).toBeUndefined()
    expect(backend.calls.map((c) => c.command)).toEqual(["mysql_connect"])
  })

  it("tracks the connection again once it connects anew", async () => {
    const backend = fakeBackend()
    restore = backend.restore
    const store = useSessionsStore.getState()
    store.forget("again")
    await store.connect("again")
    expect(useSessionsStore.getState().sessions.again?.state).toBe("connected")
  })
})

describe("state events", () => {
  it("counts a recovery from reconnecting as a reconnect", () => {
    const reconnecting = reduceStateEvent(
      { ...emptySession(), state: "connected" },
      { connectionId: "c1", state: "reconnecting" },
    )
    const recovered = reduceStateEvent(reconnecting, { connectionId: "c1", state: "connected" })
    expect(recovered).toMatchObject({ state: "connected", reconnects: 1, lastError: null })
  })

  it("counts a query retry once whether the event or the result flag arrives first", () => {
    const reconnecting = reduceStateEvent(
      { ...emptySession(), state: "connected" },
      { connectionId: "c1", state: "reconnecting" },
      0,
    )
    const eventFirst = noteRecovery(
      reduceStateEvent(reconnecting, { connectionId: "c1", state: "connected" }, 100),
      "result",
      200,
    )
    expect(eventFirst.reconnects).toBe(1)
    const resultFirst = reduceStateEvent(
      noteRecovery(reconnecting, "result", 100),
      { connectionId: "c1", state: "connected" },
      200,
    )
    expect(resultFirst.reconnects).toBe(1)
  })

  it("counts separate recoveries separately", () => {
    const once = noteRecovery(emptySession(), "result", 0)
    expect(noteRecovery(once, "result", 10).reconnects).toBe(2)
    expect(noteRecovery(once, "event", RECONNECT_DEDUPE_MS + 1).reconnects).toBe(2)
  })

  it("turns error events into a connection error", () => {
    const failed = reduceStateEvent(emptySession(), {
      connectionId: "c1",
      state: "error",
      message: "gone",
    })
    expect(failed.lastError).toEqual({ kind: "connection", message: "gone" })
  })

  it("applies events to the matching session only", () => {
    useSessionsStore.getState().applyStateEvent({ connectionId: "c2", state: "reconnecting" })
    expect(Object.keys(useSessionsStore.getState().sessions)).toEqual(["c2"])
  })

  it("validates payloads", () => {
    expect(isStateEvent({ connectionId: "c", state: "connected" })).toBe(true)
    expect(isStateEvent({ connectionId: "c", state: "weird" })).toBe(false)
    expect(isStateEvent({ state: "connected" })).toBe(false)
    expect(isStateEvent(null)).toBe(false)
  })
})
