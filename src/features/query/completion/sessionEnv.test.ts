import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport } from "../../../lib/ipc"
import type { SchemaSnapshot } from "../../../lib/mysql"
import { emptySession, useSessionsStore } from "../../../state/sessionsStore"
import { createSchemaRequests, createSessionCompletionEnv, SCHEMA_RETRY_MS } from "./sessionEnv"

const snapshot = (database: string): SchemaSnapshot => ({
  database,
  tables: [],
  fetchedAt: "2026-01-01T00:00:00Z",
})

let restore: () => void = () => {}
let schemaCalls: string[] = []

/** Fake backend whose `mysql_schema` answers `respond` (or fails when it returns null). */
function fakeBackend(respond: (database: string) => SchemaSnapshot | null = snapshot) {
  schemaCalls = []
  restore = setTransport(async (command, args) => {
    if (command !== "mysql_schema") throw { kind: "not_found", message: command }
    const database = String(args?.database)
    schemaCalls.push(database)
    const result = respond(database)
    if (!result) throw { kind: "query", message: "denied" }
    return result
  })
}

function connected(patch: Partial<ReturnType<typeof emptySession>> = {}) {
  useSessionsStore.setState({
    sessions: {
      c1: { ...emptySession(), state: "connected", databases: ["app", "shop"], ...patch },
    },
  })
}

beforeEach(() => useSessionsStore.setState({ sessions: {} }))
afterEach(() => restore())

describe("createSchemaRequests", () => {
  it("fetches a missing schema once for concurrent requests", async () => {
    fakeBackend()
    connected()
    const request = createSchemaRequests(useSessionsStore)
    const first = request("c1", "shop")
    expect(request("c1", "shop")).toBe(first)
    await first
    expect(schemaCalls).toEqual(["shop"])
    expect(useSessionsStore.getState().sessions.c1?.schemas.shop).toBeDefined()
    expect(request("c1", "shop")).toBeNull()
  })

  it("does nothing while disconnected", () => {
    fakeBackend()
    connected({ state: "reconnecting" })
    expect(createSchemaRequests(useSessionsStore)("c1", "shop")).toBeNull()
    expect(schemaCalls).toEqual([])
  })

  it("waits for a fetch someone else started instead of starting another", async () => {
    fakeBackend()
    connected({ schemaLoading: { shop: true } })
    const request = createSchemaRequests(useSessionsStore)("c1", "shop")
    expect(request).not.toBeNull()
    let settled = false
    void request?.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    useSessionsStore.setState((s) => ({
      sessions: {
        c1: { ...s.sessions.c1!, schemaLoading: {}, schemas: { shop: snapshot("shop") } },
      },
    }))
    await request
    expect(settled).toBe(true)
    expect(schemaCalls).toEqual([])
  })

  it("does not retry a failed fetch until the cool-down has passed", async () => {
    fakeBackend(() => null)
    connected()
    let now = 1000
    const request = createSchemaRequests(useSessionsStore, () => now)
    await request("c1", "shop")
    expect(request("c1", "shop")).toBeNull()
    now += SCHEMA_RETRY_MS
    await request("c1", "shop")
    expect(schemaCalls).toEqual(["shop", "shop"])
  })
})

describe("createSessionCompletionEnv", () => {
  it("reads the session's databases and schemas fresh on every call", () => {
    connected()
    const env = createSessionCompletionEnv("c1", "app")
    expect(env.catalog()).toEqual({
      currentDatabase: "app",
      databases: ["app", "shop"],
      schemas: {},
    })
    connected({ schemas: { app: snapshot("app") } })
    expect(Object.keys(env.catalog().schemas)).toEqual(["app"])
  })

  it("has an empty catalog for an unknown connection", () => {
    expect(createSessionCompletionEnv("missing", null).catalog()).toEqual({
      currentDatabase: null,
      databases: [],
      schemas: {},
    })
  })
})
