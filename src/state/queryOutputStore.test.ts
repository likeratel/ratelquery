import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport } from "../lib/ipc"
import type { ExecResult } from "../lib/mysql"
import { INITIAL_TABS } from "../lib/queryTabs"
import type { OutputEntry } from "../lib/queryOutput"
import { resetQueryOutputStore, useQueryOutputStore } from "./queryOutputStore"
import { useSessionsStore } from "./sessionsStore"
import { useTabsStore } from "./tabsStore"

const entry = (id: string, patch: Partial<OutputEntry> = {}): OutputEntry => ({
  id,
  connectionId: "c1",
  tabId: "t1",
  at: 1,
  sql: "select 1",
  sqlTruncated: false,
  elapsedMs: 1,
  outcome: { kind: "rows", rowCount: 1, truncated: false },
  ...patch,
})

const store = () => useQueryOutputStore.getState()
const ids = (connectionId = "c1") => (store().log[connectionId] ?? []).map((e) => e.id)

beforeEach(() => resetQueryOutputStore())

describe("query output store", () => {
  it("marks a tab with a new error until it is seen", () => {
    store().record([entry("a")])
    expect(store().unseenErrors).toEqual({})
    store().record([entry("b", { tabId: "t2", outcome: { kind: "error", message: "x" } })])
    expect(store().unseenErrors).toEqual({ t2: true })
    const before = store()
    store().markSeen("t1")
    expect(store()).toBe(before)
    store().markSeen("t2")
    expect(store().unseenErrors).toEqual({})
  })

  it("puts the saved log before this session's entries", () => {
    store().record([entry("new", { at: 9 })])
    store().hydrate({ c1: [entry("old")], c2: [entry("x", { connectionId: "c2" })] })
    expect(ids()).toEqual(["old", "new"])
    expect(ids("c2")).toEqual(["x"])
  })

  it("forgets a connection's entries and a closed tab's view state only", () => {
    store().record([entry("a"), entry("e", { outcome: { kind: "error", message: "x" } })])
    store().setPanel("t1", "output")
    store().forgetTab("t1")
    expect(store().panels).toEqual({})
    expect(store().unseenErrors).toEqual({})
    expect(ids()).toEqual(["a", "e"])
    store().forgetConnection("c1")
    expect(store().log).toEqual({})
  })
})

describe("runs log their output", () => {
  let restore: () => void = () => {}
  let rejectWait: (error: unknown) => void = () => {}

  const exec: ExecResult = {
    kind: "exec",
    affectedRows: 2,
    lastInsertId: "5",
    elapsedMs: 3,
    reconnected: false,
    statement: "insert into t values (1), (2)",
  }

  beforeEach(() => {
    useTabsStore.setState({ ...INITIAL_TABS })
    useSessionsStore.setState({ sessions: {} })
    restore = setTransport(async (command, args) => {
      if (command === "mysql_query") {
        if (String(args?.sql).includes("bad")) throw { kind: "query", message: "Syntax error" }
        return [exec, { ...exec, statement: "delete from t", lastInsertId: null }]
      }
      if (command === "athena_start") return { executionId: "e1" }
      if (command === "athena_wait") return new Promise((_, reject) => (rejectWait = reject))
      if (command === "athena_cancel") {
        rejectWait({ kind: "query", message: "The query was cancelled" })
        return undefined
      }
      throw { kind: "not_found", message: command }
    })
  })
  afterEach(() => restore())

  it("logs each MySQL statement, and a failed run once with its SQL", async () => {
    const tabs = useTabsStore.getState()
    const id = tabs.open("m1", "app")
    await tabs.run(id, "insert into t values (1), (2); delete from t")
    await useTabsStore.getState().run(id, "select bad")
    const log = store().log.m1
    expect(log.map((e) => [e.tabId, e.sql, e.outcome.kind])).toEqual([
      [id, "insert into t values (1), (2)", "exec"],
      [id, "delete from t", "exec"],
      [id, "select bad", "error"],
    ])
    expect(log[2].outcome).toEqual({ kind: "error", message: "Syntax error" })
    expect(store().unseenErrors).toEqual({ [id]: true })
    // A run never switches the bottom panel.
    expect(store().panels).toEqual({})
  })

  it("logs a stopped Athena run as cancelled, not as an error", async () => {
    const tabs = useTabsStore.getState()
    const id = tabs.open("a1", "sales", "athena")
    const run = tabs.run(id, "SELECT 1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    await useTabsStore.getState().cancel(id)
    await expect(run).resolves.toBe("failed")
    expect(store().log.a1.map((e) => e.outcome)).toEqual([{ kind: "cancelled" }])
    expect(store().unseenErrors).toEqual({})
  })
})
