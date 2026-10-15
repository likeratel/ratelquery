import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EMPTY_EDITS, resolveEditTarget, setCellEdit } from "../lib/gridEdits"
import { setTransport } from "../lib/ipc"
import { INITIAL_TABS, type QueryTab } from "../lib/queryTabs"
import type { QueryResult, RowsResult, SchemaSnapshot } from "../lib/mysql"
import { editTargetFor } from "../features/query/editing"
import { emptySession, useSessionsStore } from "./sessionsStore"
import { useTabsStore } from "./tabsStore"

const usersResult = (email: string, reconnected = false): RowsResult => ({
  kind: "rows",
  columns: [
    // The backend never reports the origin table; editing reads it from the statement.
    { name: "id", typeName: "INT", table: null, nullable: false },
    { name: "email", typeName: "VARCHAR", table: null, nullable: false },
  ],
  rows: [
    [
      { t: "int", v: "1" },
      { t: "str", v: email },
    ],
  ],
  rowCount: 1,
  truncated: false,
  elapsedMs: 3,
  reconnected,
  statement: "select id, email from users",
})

const schema: SchemaSnapshot = {
  database: "app",
  fetchedAt: "2026-01-01T00:00:00Z",
  tables: [
    {
      name: "users",
      kind: "table",
      columns: ["id", "email"].map((name) => ({
        name,
        typeName: "varchar(255)",
        nullable: false,
        isPrimary: name === "id",
        isAutoIncrement: false,
        defaultValue: null,
      })),
    },
  ],
}

const calls: { command: string; args?: Record<string, unknown> }[] = []
let queryResults: QueryResult[] = []
let restore: () => void = () => {}

beforeEach(() => {
  calls.length = 0
  useTabsStore.setState({ ...INITIAL_TABS })
  useSessionsStore.setState({ sessions: {} })
  restore = setTransport(async (command, args) => {
    calls.push({ command, args })
    if (command === "mysql_query") {
      if (String(args?.sql).includes("bad")) throw { kind: "query", message: "You have an error" }
      return queryResults
    }
    if (command === "mysql_apply_changes") return { affectedRows: 1, elapsedMs: 2 }
    throw { kind: "not_found", message: command }
  })
})
afterEach(() => restore())

describe("run", () => {
  it("passes the tab database and row cap, then stores results", async () => {
    queryResults = [usersResult("a@x", true)]
    const store = useTabsStore.getState()
    const id = store.open("c1", "app")
    store.setSql(id, "select id, email from users")
    await expect(useTabsStore.getState().run(id)).resolves.toBe("ran")
    expect(calls[0].args).toEqual({
      connectionId: "c1",
      sql: "select id, email from users",
      options: { maxRows: 1000, database: "app" },
    })
    const tab = useTabsStore.getState().tabs[0]
    expect(tab).toMatchObject({ running: false, results: queryResults, error: null })
    expect(useSessionsStore.getState().sessions.c1.reconnects).toBe(1)
  })

  it("runs an explicit statement and records failures", async () => {
    const id = useTabsStore.getState().open("c1", null)
    await expect(useTabsStore.getState().run(id, "bad sql")).resolves.toBe("failed")
    expect(calls[0].args?.options).toEqual({ maxRows: 1000 })
    expect(useTabsStore.getState().tabs[0].error).toEqual({
      kind: "query",
      message: "You have an error",
    })
  })

  it("refuses empty sql and blocks runs while edits are pending", async () => {
    queryResults = [usersResult("a@x")]
    const store = useTabsStore.getState()
    const id = store.open("c1", "app")
    await expect(store.run(id)).resolves.toBe("empty")
    await store.run(id, "select id, email from users")
    useTabsStore.getState().updateEdits(id, 0, (e) =>
      setCellEdit(e, queryResults[0].kind === "rows" ? queryResults[0].rows : [], 0, 1, {
        t: "str",
        v: "b@x",
      }),
    )
    await expect(useTabsStore.getState().run(id, "select 1")).resolves.toBe("pending-edits")
  })
})

describe("applyEdits", () => {
  it("sends RowChange[] keyed on the original PK, then re-runs the statement", async () => {
    queryResults = [usersResult("a@x")]
    const store = useTabsStore.getState()
    const id = store.open("c1", "app")
    await store.run(id, "select id, email from users")
    const result = (useTabsStore.getState().tabs[0] as QueryTab).results[0] as RowsResult
    useTabsStore
      .getState()
      .updateEdits(id, 0, () => setCellEdit(EMPTY_EDITS, result.rows, 0, 1, { t: "str", v: "b@x" }))
    const resolved = resolveEditTarget(result.columns, schema, "app", result.statement)
    if (!resolved.editable) throw new Error(resolved.reason)

    queryResults = [usersResult("b@x")]
    await expect(useTabsStore.getState().applyEdits(id, 0, resolved.target)).resolves.toEqual({
      affectedRows: 1,
      elapsedMs: 2,
    })
    const apply = calls.find((c) => c.command === "mysql_apply_changes")
    expect(apply?.args).toEqual({
      connectionId: "c1",
      database: "app",
      table: "users",
      changes: [
        {
          type: "update",
          key: { id: { t: "int", v: "1" } },
          set: { email: { t: "str", v: "b@x" } },
        },
      ],
    })
    const tab = useTabsStore.getState().tabs[0] as QueryTab
    expect(tab.edits[0]).toBeUndefined()
    expect((tab.results[0] as RowsResult).rows[0][1]).toEqual({ t: "str", v: "b@x" })
  })
})

const queryTab = () => useTabsStore.getState().tabs[0] as QueryTab

/** Runs the users query in a tab on the session's current database "app", with its schema. */
async function runUsers(): Promise<string> {
  queryResults = [usersResult("a@x")]
  useSessionsStore.setState({
    sessions: {
      c1: {
        ...emptySession(),
        state: "connected",
        currentDatabase: "app",
        schemas: { app: schema, shop: { ...schema, database: "shop" } },
      },
    },
  })
  const id = useTabsStore.getState().open("c1", null)
  await useTabsStore.getState().run(id, "select id, email from users")
  return id
}

function editEmail(id: string, email: string) {
  const result = queryTab().results[0] as RowsResult
  useTabsStore
    .getState()
    .updateEdits(id, 0, (e) => setCellEdit(e, result.rows, 0, 1, { t: "str", v: email }))
}

describe("database of a result", () => {
  it("records the database a run used and keeps editing aimed at it after a switch", async () => {
    const id = await runUsers()
    expect(queryTab().ranDatabase).toBe("app")
    expect(useTabsStore.getState().setDatabase(id, "shop")).toBe(true)
    const session = useSessionsStore.getState().sessions.c1
    const resolved = editTargetFor(queryTab(), queryTab().results[0], session)
    expect(resolved).toMatchObject({ editable: true, target: { database: "app", table: "users" } })
  })

  it("refuses to switch databases while edits are pending", async () => {
    const id = await runUsers()
    editEmail(id, "b@x")
    expect(useTabsStore.getState().setDatabase(id, "shop")).toBe(false)
    expect(queryTab().database).toBeNull()
    expect(calls.some((c) => c.command === "mysql_schema")).toBe(false)
  })
})

describe("applyEdits while one is in flight", () => {
  it("sends the batch once when Apply fires twice", async () => {
    const id = await runUsers()
    editEmail(id, "b@x")
    const session = useSessionsStore.getState().sessions.c1
    const resolved = editTargetFor(queryTab(), queryTab().results[0], session)
    if (!resolved.editable) throw new Error(resolved.reason)
    const store = useTabsStore.getState()
    const first = store.applyEdits(id, 0, resolved.target)
    expect(queryTab().applying).toBe(true)
    const second = store.applyEdits(id, 0, resolved.target)
    await expect(second).resolves.toBeNull()
    await expect(first).resolves.toEqual({ affectedRows: 1, elapsedMs: 2 })
    expect(calls.filter((c) => c.command === "mysql_apply_changes")).toHaveLength(1)
    expect(queryTab().applying).toBe(false)
  })

  it("clears the flag when the apply fails", async () => {
    const id = await runUsers()
    editEmail(id, "b@x")
    const session = useSessionsStore.getState().sessions.c1
    const resolved = editTargetFor(queryTab(), queryTab().results[0], session)
    if (!resolved.editable) throw new Error(resolved.reason)
    restore()
    restore = setTransport(async () => {
      throw { kind: "query", message: "Duplicate entry" }
    })
    await expect(useTabsStore.getState().applyEdits(id, 0, resolved.target)).rejects.toEqual({
      kind: "query",
      message: "Duplicate entry",
    })
    expect(queryTab()).toMatchObject({ applying: false })
    expect(queryTab().edits[0]).toBeDefined()
  })
})
