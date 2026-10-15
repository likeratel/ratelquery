import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport } from "../../lib/ipc"
import type { SchemaSnapshot, TableDetails } from "../../lib/mysql"
import { INITIAL_TABS, type QueryTab, type TableTab } from "../../lib/queryTabs"
import { emptySession, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { loadDatabases, loadTableDetails, loadTables, openTable, selectRows } from "./actions"
import { connectionKey, databaseKey, INITIAL_TREE } from "./treeState"
import { useSchemaTree } from "./treeStore"

const details: TableDetails = {
  database: "app",
  table: "users",
  kind: "table",
  engine: "InnoDB",
  rowEstimate: 2,
  dataLength: 16384,
  collation: "utf8mb4_0900_ai_ci",
  comment: "",
  columns: [],
  indexes: [],
  foreignKeys: [],
  ddl: "CREATE TABLE `users` (`id` int)",
}

const snapshot: SchemaSnapshot = {
  database: "app",
  fetchedAt: "2026-01-01T00:00:00Z",
  tables: [
    { name: "users", kind: "table", columns: [] },
    { name: "active_users", kind: "view", columns: [] },
  ],
}

/** Fake backend: answers the MySQL commands the schema feature sends and records them. */
class FakeMysql {
  calls: { command: string; args?: Record<string, unknown> }[] = []
  failDatabases = false

  handle = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ command, args })
    switch (command) {
      case "mysql_connect":
        return { serverVersion: "8.4", currentDatabase: "app" }
      case "mysql_databases":
        if (this.failDatabases) throw { kind: "connection", message: "Connection refused" }
        return ["app", "shop"]
      case "mysql_schema":
        return snapshot
      case "mysql_table_details":
        if (args?.table !== "users") throw { kind: "not_found", message: "Unknown table" }
        return details
      case "mysql_query":
        return []
      default:
        throw { kind: "not_found", message: command }
    }
  }

  count = (command: string) => this.calls.filter((c) => c.command === command).length
}

let fake: FakeMysql
let restore: () => void = () => {}

beforeEach(() => {
  fake = new FakeMysql()
  restore = setTransport(fake.handle)
  useTabsStore.setState({ ...INITIAL_TABS })
  useSessionsStore.setState({ sessions: {} })
  useSchemaTree.setState({ ...INITIAL_TREE })
})
afterEach(() => restore())

describe("tree loading", () => {
  it("connects, lists databases once and reports failures for a retry", async () => {
    fake.failDatabases = true
    await loadDatabases("c1")
    const key = connectionKey("c1")
    expect(useSchemaTree.getState().loads[key]).toMatchObject({
      status: "error",
      error: { kind: "connection", message: "Connection refused" },
    })
    expect(fake.count("mysql_connect")).toBe(1)

    fake.failDatabases = false
    await loadDatabases("c1")
    expect(useSchemaTree.getState().loads[key]).toMatchObject({
      status: "ready",
      children: [
        { name: "app", kind: "database" },
        { name: "shop", kind: "database" },
      ],
    })
    // The session store also lists databases after connecting; only the tree's own call counts.
    const before = fake.count("mysql_databases")
    await loadDatabases("c1")
    expect(fake.count("mysql_databases")).toBe(before)
  })

  it("reuses the session's schema snapshot and refetches only on refresh", async () => {
    useSessionsStore.setState({
      sessions: { c1: { ...emptySession(), state: "connected", schemas: { app: snapshot } } },
    })
    await loadTables("c1", "app")
    expect(fake.calls).toEqual([])
    expect(useSchemaTree.getState().loads[databaseKey("c1", "app")]?.children).toEqual([
      { name: "users", kind: "table" },
      { name: "active_users", kind: "view" },
    ])
    await loadTables("c1", "app", true)
    expect(fake.count("mysql_schema")).toBe(1)
  })
})

describe("table tabs", () => {
  const tableTab = () => useTabsStore.getState().tabs.find((t) => t.kind === "table") as TableTab

  it("caches details and only refetches on refresh", async () => {
    const id = openTable("c1", "app", "users")
    await loadTableDetails(id)
    expect(tableTab()).toMatchObject({ loading: false, details, error: null })
    expect(fake.calls.find((c) => c.command === "mysql_table_details")?.args).toEqual({
      connectionId: "c1",
      database: "app",
      table: "users",
    })

    useTabsStore.getState().open("c1", "app")
    expect(openTable("c1", "app", "users")).toBe(id)
    await loadTableDetails(id)
    expect(useTabsStore.getState().activeId).toBe(id)
    expect(fake.count("mysql_table_details")).toBe(1)

    await loadTableDetails(id, true)
    expect(fake.count("mysql_table_details")).toBe(2)
  })

  it("keeps a not_found error on the tab", async () => {
    const id = openTable("c1", "app", "gone")
    await loadTableDetails(id)
    expect(tableTab()).toMatchObject({ loading: false, error: { kind: "not_found" } })
    // Without a refresh the error isn't retried in a loop.
    await loadTableDetails(id)
    expect(fake.count("mysql_table_details")).toBe(1)
  })
})

describe("selectRows", () => {
  it("opens a query tab on the table's database and runs the select", async () => {
    await selectRows("c1", "shop", "order`items")
    const tab = useTabsStore.getState().tabs[0] as QueryTab
    expect(tab).toMatchObject({ kind: "query", database: "shop" })
    expect(tab.sql).toBe("SELECT * FROM `order``items` LIMIT 1000")
    const run = fake.calls.find((c) => c.command === "mysql_query")
    expect(run?.args).toMatchObject({
      sql: "SELECT * FROM `order``items` LIMIT 1000",
      options: { database: "shop" },
    })
  })
})
