import { describe, expect, it } from "vitest"
import { createDynamoTab, openEditor, updateEditor } from "./dynamoTabs"
import { EMPTY_EDITS, toggleRowDelete } from "./gridEdits"
import type { QueryResult, TableDetails } from "./mysql"
import {
  activateTab,
  cancelCloseTab,
  closeTab,
  confirmCloseTab,
  failRun,
  failTableLoad,
  findTableTab,
  finishRun,
  finishTableLoad,
  hasUnsavedWork,
  INITIAL_TABS,
  isTabDirty,
  isWorkspaceTabDirty,
  openTab,
  openTableTab,
  preferredResultIndex,
  replaceResult,
  requestCloseTab,
  setTabEdits,
  startRun,
  startTableLoad,
  tabPendingCount,
  updateTab,
  updateTableTab,
  type QueryTab,
  type TableTab,
} from "./queryTabs"

const exec = (statement: string): QueryResult => ({
  kind: "exec",
  affectedRows: 1,
  lastInsertId: null,
  elapsedMs: 5,
  reconnected: false,
  statement,
})

const rows = (statement: string): QueryResult => ({
  kind: "rows",
  columns: [],
  rows: [],
  rowCount: 0,
  truncated: false,
  elapsedMs: 7,
  reconnected: false,
  statement,
})

const three = () =>
  ["a", "b", "c"].reduce(
    (state, id) => openTab(state, { id, connectionId: "conn", database: "app" }),
    INITIAL_TABS,
  )

describe("tab list", () => {
  it("opens numbered tabs and activates the newest", () => {
    const state = three()
    expect(state.tabs.map((t) => t.title)).toEqual(["Query 1", "Query 2", "Query 3"])
    expect(state.activeId).toBe("c")
    expect(INITIAL_TABS.tabs).toEqual([])
  })

  it("activates the right neighbour on close, else the left one", () => {
    const middle = closeTab(activateTab(three(), "b"), "b")
    expect(middle.activeId).toBe("c")
    const last = closeTab(three(), "c")
    expect(last.activeId).toBe("b")
    const inactive = closeTab(three(), "a")
    expect(inactive.activeId).toBe("c")
    const none = closeTab(
      openTab(INITIAL_TABS, { id: "x", connectionId: "c", database: null }),
      "x",
    )
    expect(none).toMatchObject({ tabs: [], activeId: null })
  })

  it("keeps a connection's tabs together and remembers its active tab", () => {
    const state = [
      { id: "a1", connectionId: "a" },
      { id: "b1", connectionId: "b" },
      { id: "a2", connectionId: "a" },
    ].reduce((s, params) => openTab(s, { ...params, database: null }), INITIAL_TABS)
    expect(state.tabs.map((t) => t.id)).toEqual(["a1", "a2", "b1"])
    expect(state.recent).toEqual({ a: "a2", b: "b1" })
    const table = openTableTab(state, {
      id: "b2",
      connectionId: "b",
      database: "app",
      table: "users",
    })
    expect(table.tabs.map((t) => t.id)).toEqual(["a1", "a2", "b1", "b2"])
    expect(activateTab(table, "a1").recent).toEqual({ a: "a1", b: "b2" })
  })

  it("never jumps to another connection while the closed tab's connection has tabs", () => {
    const state = [
      { id: "a1", connectionId: "a" },
      { id: "b1", connectionId: "b" },
      { id: "a2", connectionId: "a" },
    ].reduce((s, params) => openTab(s, { ...params, database: null }), INITIAL_TABS)
    // a1 a2 | b1, with a2 active: the right neighbour in the flat list would be b1.
    const closed = closeTab(state, "a2")
    expect(closed.activeId).toBe("a1")
    expect(closed.recent).toEqual({ a: "a1", b: "b1" })
    // The last tab of b goes back to the tab last used on a.
    const back = closeTab(activateTab(closed, "b1"), "b1")
    expect(back.activeId).toBe("a1")
    expect(back.recent).toEqual({ a: "a1" })
  })

  it("drops a pending group close once the connection has no tabs left", () => {
    const state = [
      { id: "a1", connectionId: "a" },
      { id: "a2", connectionId: "a" },
      { id: "b1", connectionId: "b" },
    ].reduce((s, params) => openTab(s, { ...params, database: null }), INITIAL_TABS)
    const asking = { ...state, closingGroup: "a" }
    const one = closeTab(asking, "a1")
    expect(one.closingGroup).toBe("a")
    expect(closeTab(one, "a2").closingGroup).toBeNull()
    expect(closeTab(asking, "b1").closingGroup).toBe("a")
  })

  it("keeps numbering monotonic after closing", () => {
    const reopened = openTab(closeTab(three(), "c"), { id: "d", connectionId: "c", database: null })
    expect(reopened.tabs.at(-1)?.title).toBe("Query 4")
  })

  it("ignores unknown ids", () => {
    const state = three()
    expect(activateTab(state, "zzz")).toBe(state)
    expect(closeTab(state, "zzz")).toBe(state)
  })
})

describe("run lifecycle", () => {
  const tab = () => three().tabs[0] as QueryTab

  it("stores results, picks the last rows result and sums elapsed", () => {
    const running = startRun({ ...tab(), sql: "select 1; update t" })
    expect(running.running).toBe(true)
    const done = finishRun(running, running.sql, [rows("select 1"), exec("update t")])
    expect(done).toMatchObject({ running: false, activeResult: 0, lastElapsedMs: 12, runId: 1 })
    expect(isTabDirty(done)).toBe(false)
    expect(isTabDirty({ ...done, sql: "select 2" })).toBe(true)
  })

  it("keeps previous results when a run fails", () => {
    const done = finishRun(startRun(tab()), "select 1", [rows("select 1")])
    const failed = failRun(startRun(done), "bad", { kind: "query", message: "syntax" })
    expect(failed.results).toHaveLength(1)
    expect(failed.error).toEqual({ kind: "query", message: "syntax" })
  })

  it("prefers the last rows result", () => {
    expect(preferredResultIndex([exec("a"), exec("b")])).toBe(1)
    expect(preferredResultIndex([rows("a"), exec("b"), rows("c"), exec("d")])).toBe(2)
    expect(preferredResultIndex([])).toBe(0)
  })

  it("tracks pending edits per result and clears them on replace", () => {
    const done = finishRun(startRun(tab()), "s", [rows("s")])
    const edited = setTabEdits(done, 0, toggleRowDelete(EMPTY_EDITS, 0))
    expect(tabPendingCount(edited)).toBe(1)
    expect(isTabDirty(edited)).toBe(true)
    const replaced = replaceResult(edited, 0, rows("s"))
    expect(tabPendingCount(replaced)).toBe(0)
    expect(replaced.runId).toBe(done.runId + 1)
  })

  it("updates only the targeted tab", () => {
    const state = updateTab(three(), "b", (t) => ({ ...t, sql: "x" }))
    expect(state.tabs.map((t) => (t as QueryTab).sql)).toEqual(["", "x", ""])
  })
})

describe("closing tabs with unsaved work", () => {
  const withEdits = () =>
    updateTab(three(), "b", (t) => setTabEdits(t, 0, toggleRowDelete(EMPTY_EDITS, 0)))

  it("closes clean tabs at once, even with unrun SQL", () => {
    const state = requestCloseTab(
      updateTab(three(), "b", (t) => ({ ...t, sql: "select 1" })),
      "b",
    )
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "c"])
    expect(state.closing).toBeNull()
  })

  it("asks before closing a tab with pending grid edits", () => {
    const asked = requestCloseTab(withEdits(), "b")
    expect(asked.tabs.map((t) => t.id)).toEqual(["a", "b", "c"])
    expect(asked.closing).toBe("b")
    const kept = cancelCloseTab(asked)
    expect(kept).toMatchObject({ closing: null })
    expect(kept.tabs).toHaveLength(3)
    const closed = confirmCloseTab(asked)
    expect(closed.tabs.map((t) => t.id)).toEqual(["a", "c"])
    expect(closed.closing).toBeNull()
  })

  it("asks before closing a DynamoDB tab whose item editor has unsaved text", () => {
    const editing = updateEditor(
      openEditor(createDynamoTab("d", "conn", "DynamoDB 1"), null, "plain"),
      {
        text: '{ "pk": "x" }',
      },
    )
    const state = { ...three(), tabs: [...three().tabs, editing] }
    expect(requestCloseTab(state, "d").closing).toBe("d")
    const clean = { ...state, tabs: [...three().tabs, openEditor(editing, null, "plain")] }
    expect(requestCloseTab(clean, "d").tabs.map((t) => t.id)).toEqual(["a", "b", "c"])
  })

  it("ignores unknown tabs and confirmations with nothing pending", () => {
    const state = three()
    expect(requestCloseTab(state, "zz")).toBe(state)
    expect(confirmCloseTab(state)).toBe(state)
    expect(cancelCloseTab(state)).toBe(state)
  })
})

describe("table tabs", () => {
  const users = { id: "t1", connectionId: "conn", database: "app", table: "users" }
  const details: TableDetails = {
    database: "app",
    table: "users",
    kind: "table",
    engine: "InnoDB",
    rowEstimate: 3,
    dataLength: 16384,
    collation: null,
    comment: "",
    columns: [],
    indexes: [],
    foreignKeys: [],
    ddl: "CREATE TABLE `users` ()",
  }
  const tableTab = (state: ReturnType<typeof three>) => state.tabs.at(-1) as TableTab

  it("opens a tab titled with the table and activates it", () => {
    const state = openTableTab(three(), users)
    expect(tableTab(state)).toMatchObject({
      kind: "table",
      title: "users",
      database: "app",
      details: null,
      loading: false,
    })
    expect(state.activeId).toBe("t1")
    // Query numbering is untouched.
    expect(state.seq).toBe(three().seq)
  })

  it("activates the open tab instead of opening the same table twice", () => {
    const opened = activateTab(openTableTab(three(), users), "a")
    const again = openTableTab(opened, { ...users, id: "t2" })
    expect(again.tabs).toHaveLength(4)
    expect(again.activeId).toBe("t1")
    const otherDb = openTableTab(opened, { ...users, id: "t3", database: "shop" })
    expect(otherDb.tabs).toHaveLength(5)
    expect(findTableTab(otherDb, { ...users, database: "shop" })?.id).toBe("t3")
    expect(findTableTab(otherDb, { ...users, table: "nope" })).toBeNull()
  })

  it("closes at once; it never holds unsaved work", () => {
    const state = openTableTab(three(), users)
    expect(hasUnsavedWork(tableTab(state))).toBe(false)
    expect(isWorkspaceTabDirty(tableTab(state))).toBe(false)
    const closed = requestCloseTab(state, "t1")
    expect(closed.tabs.map((t) => t.id)).toEqual(["a", "b", "c"])
    expect(closed.activeId).toBe("c")
    expect(closed.closing).toBeNull()
  })

  it("caches details and drops responses from older requests", () => {
    const loading = startTableLoad(tableTab(openTableTab(three(), users)))
    expect(loading).toMatchObject({ loading: true, requestId: 1 })
    const done = finishTableLoad(loading, 1, details)
    expect(done).toMatchObject({ loading: false, details, error: null })
    const refreshing = startTableLoad(done)
    expect(refreshing.details).toBe(details)
    expect(finishTableLoad(refreshing, 1, { ...details, rowEstimate: 9 })).toBe(refreshing)
    const failed = failTableLoad(refreshing, 2, { kind: "not_found", message: "gone" })
    expect(failed).toMatchObject({ loading: false, error: { kind: "not_found" }, details })
    expect(failTableLoad(refreshing, 1, { kind: "query", message: "x" })).toBe(refreshing)
  })

  it("updates only table tabs", () => {
    const state = openTableTab(three(), users)
    const next = updateTableTab(state, "a", (t) => ({ ...t, loading: true }))
    expect(next.tabs).toEqual(state.tabs)
    const updated = updateTableTab(state, "t1", (t) => ({ ...t, loading: true }))
    expect(tableTab(updated).loading).toBe(true)
    expect(updateTab(state, "t1", (t) => ({ ...t, sql: "x" })).tabs).toEqual(state.tabs)
  })
})
