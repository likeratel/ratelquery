import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AthenaRowsResult } from "../lib/athena"
import { setTransport } from "../lib/ipc"
import { INITIAL_TABS, type QueryTab } from "../lib/queryTabs"
import { editTargetFor } from "../features/query/editing"
import { useAthenaStore } from "./athenaStore"
import { useTabsStore } from "./tabsStore"

const rows = (statement: string, executionId: string): AthenaRowsResult => ({
  kind: "rows",
  columns: [{ name: "n", typeName: "INTEGER", table: null, nullable: true }],
  rows: [[{ t: "int", v: "1" }]],
  rowCount: 1,
  truncated: false,
  elapsedMs: 10,
  reconnected: false,
  statement,
  athena: { executionId, dataScannedBytes: 2048, engineMs: 7, outputLocation: "s3://r/" },
})

const calls: { command: string; args?: Record<string, unknown> }[] = []
let started = 0
/** Pending `athena_wait` answers, released by the test. */
let waiting: { resolve: (r: unknown) => void; reject: (e: unknown) => void }[] = []
let holdWaits = false
let restore: () => void = () => {}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  calls.length = 0
  started = 0
  waiting = []
  holdWaits = false
  useTabsStore.setState({ ...INITIAL_TABS })
  useAthenaStore.setState({ catalogs: {} })
  restore = setTransport(async (command, args) => {
    calls.push({ command, args })
    if (command === "athena_start") {
      if (String(args?.sql).includes("bad")) throw { kind: "invalid_input", message: "nope" }
      started += 1
      return { executionId: `e${started}` }
    }
    if (command === "athena_wait") {
      const id = String(args?.executionId)
      if (holdWaits) return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
      return rows(`statement of ${id}`, id)
    }
    if (command === "athena_cancel") return undefined
    throw { kind: "not_found", message: command }
  })
})
afterEach(() => restore())

const tab = (id: string) =>
  useTabsStore.getState().tabs.find((t): t is QueryTab => t.id === id && t.kind === "query")!

function openAthena(sql: string, database: string | null = "sales") {
  const store = useTabsStore.getState()
  const id = store.open("a1", database, "athena")
  store.setSql(id, sql)
  return id
}

describe("Athena run", () => {
  it("starts and waits for each statement in order, then stores one result each", async () => {
    const id = openAthena("SELECT 1;\nSELECT 2;")
    await expect(useTabsStore.getState().run(id)).resolves.toBe("ran")
    expect(calls.map((c) => c.command)).toEqual([
      "athena_start",
      "athena_wait",
      "athena_start",
      "athena_wait",
    ])
    expect(calls[0].args).toEqual({
      connectionId: "a1",
      sql: "SELECT 1",
      options: { maxRows: 1000, database: "sales" },
    })
    expect(calls[1].args).toEqual({ connectionId: "a1", executionId: "e1", maxRows: 1000 })
    expect(calls[2].args?.sql).toBe("SELECT 2")
    const done = tab(id)
    expect(done.results).toHaveLength(2)
    expect(done).toMatchObject({ running: false, executionId: null, ranDatabase: "sales" })
    expect(calls.some((c) => c.command === "mysql_query")).toBe(false)
  })

  it("uses the connection's current database when the tab has none", async () => {
    useAthenaStore.setState({
      catalogs: {
        a1: {
          databases: ["raw"],
          schemas: {},
          currentDatabase: "raw",
          loading: false,
          schemaLoading: {},
          lastError: null,
        },
      },
    })
    const id = openAthena("SELECT 1", null)
    await useTabsStore.getState().run(id)
    expect(calls[0].args?.options).toEqual({ maxRows: 1000, database: "raw" })
  })

  it("stops at a failed statement and never starts the rest", async () => {
    const id = openAthena("SELECT 1; SELECT bad; SELECT 3")
    await expect(useTabsStore.getState().run(id)).resolves.toBe("failed")
    expect(calls.filter((c) => c.command === "athena_start")).toHaveLength(2)
    expect(tab(id).error).toEqual({ kind: "invalid_input", message: "nope" })
    expect(tab(id).executionId).toBeNull()
  })

  it("keeps the running execution id and cancels it on request", async () => {
    holdWaits = true
    const id = openAthena("SELECT 1; SELECT 2")
    const run = useTabsStore.getState().run(id)
    await flush()
    expect(tab(id)).toMatchObject({ running: true, executionId: "e1" })
    await useTabsStore.getState().cancel(id)
    expect(calls.at(-1)).toEqual({
      command: "athena_cancel",
      args: { connectionId: "a1", executionId: "e1" },
    })
    waiting[0]?.reject({ kind: "query", message: "The query was cancelled" })
    await expect(run).resolves.toBe("failed")
    expect(tab(id).error?.message).toBe("The query was cancelled")
    // The second statement never started.
    expect(calls.filter((c) => c.command === "athena_start")).toHaveLength(1)
  })

  it("stops an execution whose id arrives after the cancel", async () => {
    let releaseStart: () => void = () => {}
    restore()
    restore = setTransport(async (command, args) => {
      calls.push({ command, args })
      if (command === "athena_start") {
        await new Promise<void>((resolve) => (releaseStart = resolve))
        return { executionId: "late" }
      }
      if (command === "athena_cancel") return undefined
      throw { kind: "not_found", message: command }
    })
    const id = openAthena("SELECT 1")
    const run = useTabsStore.getState().run(id)
    await flush()
    await useTabsStore.getState().cancel(id)
    expect(calls.some((c) => c.command === "athena_cancel")).toBe(false)
    releaseStart()
    await expect(run).resolves.toBe("failed")
    expect(calls.map((c) => c.command)).toEqual(["athena_start", "athena_cancel"])
    expect(calls[1].args).toEqual({ connectionId: "a1", executionId: "late" })
  })

  it("stops an execution whose id arrives after its tab closed", async () => {
    let releaseStart: () => void = () => {}
    restore()
    restore = setTransport(async (command, args) => {
      calls.push({ command, args })
      if (command === "athena_start") {
        await new Promise<void>((resolve) => (releaseStart = resolve))
        return { executionId: "orphan" }
      }
      if (command === "athena_cancel") return undefined
      throw { kind: "not_found", message: command }
    })
    const id = openAthena("SELECT 1; SELECT 2")
    const run = useTabsStore.getState().run(id)
    await flush()
    // Closed without a cancel (the store alone): the run notices the tab is gone.
    useTabsStore.getState().close(id)
    releaseStart()
    await expect(run).resolves.toBe("failed")
    expect(calls.map((c) => c.command)).toEqual(["athena_start", "athena_cancel"])
    expect(calls[1].args).toEqual({ connectionId: "a1", executionId: "orphan" })
  })

  it("reports an empty script without calling Athena", async () => {
    const id = openAthena(" ;; -- nothing")
    await expect(useTabsStore.getState().run(id)).resolves.toBe("empty")
    expect(calls).toEqual([])
  })

  it("never offers editing for Athena results", async () => {
    const id = openAthena("SELECT n FROM t")
    await useTabsStore.getState().run(id)
    const done = tab(id)
    expect(editTargetFor(done, done.results[0], undefined)).toEqual({
      editable: false,
      reason: "Athena results are read only",
    })
    // Even a result without stats is read only in an Athena tab.
    const plain = { ...done.results[0], athena: undefined }
    expect(
      editTargetFor({ ranDatabase: "sales", engine: "athena" }, plain, undefined).editable,
    ).toBe(false)
  })

  it("switching the database updates the Athena catalog, not a MySQL session", async () => {
    const id = openAthena("SELECT 1")
    expect(useTabsStore.getState().setDatabase(id, "raw")).toBe(true)
    await flush()
    expect(useAthenaStore.getState().catalogs.a1?.currentDatabase).toBe("raw")
    expect(calls.map((c) => c.command)).toEqual(["athena_schema"])
  })
})
