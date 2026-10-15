import { describe, expect, it } from "vitest"
import { shallow } from "zustand/shallow"
import { openTab, openTableTab, updateTab, INITIAL_TABS, type QueryTab } from "./queryTabs"
import { selectResultsView, selectTabSummary } from "./tabViews"

const state = openTab(INITIAL_TABS, { id: "q1", connectionId: "c1", database: null })
const typed = (sql: string) =>
  updateTab(state, "q1", (tab: QueryTab) => ({ ...tab, sql, sqlAtRun: "select 1" }))

describe("selectTabSummary", () => {
  it("stays shallow-equal while typing keeps the dirty marker", () => {
    const before = selectTabSummary(typed("select 2"), "q1")
    const after = selectTabSummary(typed("select 23"), "q1")
    expect(before?.dirty).toBe(true)
    expect(shallow(before, after)).toBe(true)
  })

  it("changes when the dirty marker flips", () => {
    const clean = selectTabSummary(typed("select 1"), "q1")
    const dirty = selectTabSummary(typed("select 2"), "q1")
    expect(shallow(clean, dirty)).toBe(false)
  })

  it("names a table tab by database and table", () => {
    const withTable = openTableTab(state, {
      id: "t1",
      connectionId: "c1",
      database: "shop",
      table: "orders",
    })
    expect(selectTabSummary(withTable, "t1")).toMatchObject({
      kind: "table",
      title: "orders",
      longName: "shop.orders",
    })
    expect(selectTabSummary(withTable, "gone")).toBeNull()
  })
})

describe("selectResultsView", () => {
  it("ignores editor text", () => {
    expect(shallow(selectResultsView(typed("a"), "q1"), selectResultsView(typed("ab"), "q1"))).toBe(
      true,
    )
  })

  it("is null for other tab kinds", () => {
    const withTable = openTableTab(state, {
      id: "t1",
      connectionId: "c1",
      database: "d",
      table: "t",
    })
    expect(selectResultsView(withTable, "t1")).toBeNull()
  })
})
