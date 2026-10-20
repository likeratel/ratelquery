import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { emptyAthenaCatalog } from "../../lib/athenaCatalog"
import { emitAppEvent } from "../../lib/events"
import { setTransport } from "../../lib/ipc"
import { INITIAL_TABS, type QueryTab } from "../../lib/queryTabs"
import { useAthenaStore } from "../../state/athenaStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import {
  logRunResults,
  resetQueryOutputStore,
  useQueryOutputStore,
} from "../../state/queryOutputStore"
import { emptySession, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { emptyCatalog, useDynamoCatalog } from "../dynamo/catalogStore"
import { subscribeTreeCleanup } from "../schema"
import { connectionKey, databaseKey } from "../schema/treeState"
import { useSchemaTree } from "../schema/treeStore"
import { subscribeConnectionCleanup } from "./actions"

let restore: () => void = () => {}
let unsubscribe: () => void = () => {}
let unsubscribeTree: () => void = () => {}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  useTabsStore.setState({ ...INITIAL_TABS })
  useSessionsStore.setState({ sessions: { m1: emptySession(), m2: emptySession() } })
  useDynamoCatalog.setState({ catalogs: { d1: emptyCatalog(), d2: emptyCatalog() } })
  useConnectionsStore.setState({
    connections: [
      { kind: "mysql", id: "m1", name: "A", host: "h", port: 3306, user: "u" },
      {
        kind: "dynamodb",
        id: "d1",
        name: "B",
        region: "us-east-1",
        auth: { type: "profile", profile: "p" },
      },
      {
        kind: "athena",
        id: "a1",
        name: "Lake",
        region: "eu-west-1",
        auth: { type: "profile", profile: "p" },
      },
    ],
  })
  unsubscribe = subscribeConnectionCleanup()
  unsubscribeTree = subscribeTreeCleanup()
})

afterEach(() => {
  unsubscribe()
  unsubscribeTree()
  restore()
})

describe("deleting a connection", () => {
  it("closes its tabs and drops its session and catalog", async () => {
    let fail = false
    restore = setTransport(async (command) => {
      if (command === "connections_delete" && fail) throw { kind: "io", message: "disk full" }
      return undefined
    })
    const tabs = useTabsStore.getState()
    tabs.open("m1", "app")
    tabs.open("m1", null)
    const keep = tabs.open("m2", null)
    tabs.openDynamo("d1")
    const keepDynamo = tabs.openDynamo("d2")
    resetQueryOutputStore()
    const exec = {
      kind: "exec",
      affectedRows: 1,
      lastInsertId: null,
      elapsedMs: 1,
      reconnected: false,
      statement: "delete from t",
    } as const
    logRunResults("m1", "t1", [exec])
    logRunResults("m2", keep, [exec])

    await useConnectionsStore.getState().remove("m1")
    await useConnectionsStore.getState().remove("d1")
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual([keep, keepDynamo])
    expect(Object.keys(useSessionsStore.getState().sessions)).toEqual(["m2"])
    expect(Object.keys(useDynamoCatalog.getState().catalogs)).toEqual(["d2"])
    expect(Object.keys(useQueryOutputStore.getState().log)).toEqual(["m2"])

    fail = true
    await expect(useConnectionsStore.getState().remove("m2")).resolves.toMatchObject({ ok: false })
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual([keep, keepDynamo])
  })
})

describe("editing an Athena connection", () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  let rejectWait: (error: unknown) => void = () => {}

  beforeEach(() => {
    calls.length = 0
    restore = setTransport(async (command, args) => {
      calls.push({ command, args })
      if (command === "athena_start") return { executionId: `e${calls.length}` }
      if (command === "athena_wait") return new Promise((_, reject) => (rejectWait = reject))
      if (command === "athena_cancel") return undefined
      throw { kind: "not_found", message: command }
    })
  })

  const queryTab = (id: string) =>
    useTabsStore.getState().tabs.find((t): t is QueryTab => t.id === id && t.kind === "query")

  it("stops the running statement so the rest never starts with the new settings", async () => {
    const tabs = useTabsStore.getState()
    const id = tabs.open("a1", "sales", "athena")
    tabs.setSql(id, "SELECT 1; SELECT 2")
    const run = tabs.run(id)
    await flush()
    expect(queryTab(id)).toMatchObject({ running: true, executionId: "e1" })

    emitAppEvent("connection-updated", "a1")
    await flush()
    // The backend stopped the old client's executions on save; a cancel through the new client
    // would hit another region or account.
    expect(calls.some((c) => c.command === "athena_cancel")).toBe(false)
    rejectWait({ kind: "query", message: "The query was cancelled" })
    await expect(run).resolves.toBe("failed")
    expect(calls.filter((c) => c.command === "athena_start")).toHaveLength(1)
    // The tab stays open with the cancelled run's error.
    expect(queryTab(id)?.error?.message).toBe("The query was cancelled")
  })

  it("drops the Athena catalog and the tree of the edited connection only", () => {
    useAthenaStore.setState({ catalogs: { a1: emptyAthenaCatalog("sales") } })
    const tree = useSchemaTree.getState()
    for (const key of [connectionKey("a1"), databaseKey("a1", "sales"), connectionKey("m1")]) {
      tree.resolve(key, tree.begin(key), [])
    }

    emitAppEvent("connection-updated", "m1")
    expect(Object.keys(useSchemaTree.getState().loads)).toContain(connectionKey("m1"))

    emitAppEvent("connection-updated", "a1")
    expect(useAthenaStore.getState().catalogs).toEqual({})
    expect(Object.keys(useSchemaTree.getState().loads)).toEqual([connectionKey("m1")])
    expect(calls).toEqual([])
  })
})
