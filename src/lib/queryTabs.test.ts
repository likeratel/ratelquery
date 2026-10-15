import { describe, expect, it } from "vitest"
import { createDynamoTab, openEditor, updateEditor } from "./dynamoTabs"
import { EMPTY_EDITS, toggleRowDelete } from "./gridEdits"
import type { QueryResult } from "./mysql"
import {
  activateTab,
  cancelCloseTab,
  closeTab,
  confirmCloseTab,
  failRun,
  finishRun,
  INITIAL_TABS,
  isTabDirty,
  openTab,
  preferredResultIndex,
  replaceResult,
  requestCloseTab,
  setTabEdits,
  startRun,
  tabPendingCount,
  updateTab,
  type QueryTab,
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
