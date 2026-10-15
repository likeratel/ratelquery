import { describe, expect, it } from "vitest"
import {
  childKey,
  databaseKey,
  failLoad,
  filterChildren,
  finishLoad,
  forgetConnection,
  INITIAL_TREE,
  isDescendant,
  needsLoad,
  setExpanded,
  setFilter,
  setFocused,
  startLoad,
  tableChildren,
  toggleExpanded,
  type TreeChild,
} from "./treeState"

const users: TreeChild = { name: "users", kind: "table" }
const orders: TreeChild = { name: "orders", kind: "table" }
const active: TreeChild = { name: "active_users", kind: "view" }

describe("keys", () => {
  it("nests database and table keys under the connection", () => {
    const db = databaseKey("conn", "app")
    expect(isDescendant(db, "conn")).toBe(true)
    expect(isDescendant(childKey(db, "users"), "conn")).toBe(true)
    expect(isDescendant("conn", "conn")).toBe(false)
    // A connection whose id shares a prefix is not an ancestor.
    expect(isDescendant(databaseKey("conn2", "app"), "conn")).toBe(false)
  })
})

describe("expansion", () => {
  it("toggles a node without touching others", () => {
    const once = toggleExpanded(INITIAL_TREE, "conn")
    expect(once.expanded).toEqual({ conn: true })
    expect(toggleExpanded(once, "conn").expanded).toEqual({ conn: false })
    expect(INITIAL_TREE.expanded).toEqual({})
  })

  it("moves the tab stop up when collapsing hides the focused node", () => {
    const db = databaseKey("conn", "app")
    const focused = setFocused(setExpanded(INITIAL_TREE, "conn", true), childKey(db, "users"))
    expect(setExpanded(focused, "conn", false).focused).toBe("conn")
    expect(setExpanded(focused, "other", false).focused).toBe(childKey(db, "users"))
  })
})

describe("loading", () => {
  const key = databaseKey("conn", "app")

  it("goes loading → ready and keeps old children while refreshing", () => {
    const loading = startLoad(INITIAL_TREE, key)
    expect(loading.loads[key]).toMatchObject({ status: "loading", children: null, requestId: 1 })
    expect(needsLoad(loading, key)).toBe(false)
    const ready = finishLoad(loading, key, 1, [users])
    expect(ready.loads[key]).toMatchObject({ status: "ready", children: [users], error: null })
    const refreshing = startLoad(ready, key)
    expect(refreshing.loads[key]).toMatchObject({ status: "loading", children: [users] })
  })

  it("records an error and asks for a retry", () => {
    const failed = failLoad(startLoad(INITIAL_TREE, key), key, 1, {
      kind: "connection",
      message: "refused",
    })
    expect(failed.loads[key]).toMatchObject({ status: "error", error: { kind: "connection" } })
    expect(needsLoad(failed, key)).toBe(true)
    expect(needsLoad(INITIAL_TREE, key)).toBe(true)
    expect(startLoad(failed, key).loads[key]).toMatchObject({ status: "loading", error: null })
  })

  it("ignores a response from an older request", () => {
    const twice = startLoad(startLoad(INITIAL_TREE, key), key)
    expect(finishLoad(twice, key, 1, [users])).toBe(twice)
    expect(failLoad(twice, key, 1, { kind: "query", message: "x" })).toBe(twice)
    expect(finishLoad(INITIAL_TREE, key, 1, [users])).toBe(INITIAL_TREE)
  })

  it("moves the tab stop to the parent when its table disappears", () => {
    const focused = setFocused(startLoad(INITIAL_TREE, key), childKey(key, "users"))
    expect(finishLoad(focused, key, 1, [orders]).focused).toBe(key)
    expect(finishLoad(focused, key, 1, [users, orders]).focused).toBe(childKey(key, "users"))
  })
})

describe("forgetConnection", () => {
  it("drops the connection and everything under it", () => {
    const key = databaseKey("conn", "app")
    let state = setExpanded(setExpanded(INITIAL_TREE, "conn", true), key, true)
    state = setExpanded(state, "other", true)
    state = setFilter(startLoad(state, key), key, "us")
    state = setFocused(state, key)
    const next = forgetConnection(state, "conn")
    expect(next.expanded).toEqual({ other: true })
    expect(next.loads).toEqual({})
    expect(next.filters).toEqual({})
    expect(next.focused).toBeNull()
  })
})

describe("children", () => {
  it("maps schema tables and views", () => {
    expect(
      tableChildren([
        { name: "users", kind: "table", columns: [] },
        { name: "active_users", kind: "view", columns: [] },
      ]),
    ).toEqual([users, active])
  })

  it("filters by a case-insensitive substring", () => {
    expect(filterChildren([users, orders, active], " USER ")).toEqual([users, active])
    expect(filterChildren([users, orders], "")).toEqual([users, orders])
  })
})
