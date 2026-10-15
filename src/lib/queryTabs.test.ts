import { describe, expect, it } from "vitest"
import { EMPTY_EDITS, toggleRowDelete } from "./gridEdits"
import type { QueryResult } from "./mysql"
import {
  activateTab,
  closeTab,
  failRun,
  finishRun,
  INITIAL_TABS,
  isTabDirty,
  openTab,
  preferredResultIndex,
  replaceResult,
  setTabEdits,
  startRun,
  tabPendingCount,
  updateTab,
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
  const tab = () => three().tabs[0]

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
    expect(state.tabs.map((t) => t.sql)).toEqual(["", "x", ""])
  })
})
