import { beforeEach, describe, expect, it } from "vitest"
import { EMPTY_EDITS, toggleRowDelete } from "../../lib/gridEdits"
import { createTab, INITIAL_TABS } from "../../lib/queryTabs"
import { useTabsStore } from "../../state/tabsStore"
import { closeConnectionTabs, confirmCloseGroup, cancelCloseGroup } from "./actions"

const ids = () => useTabsStore.getState().tabs.map((t) => t.id)
const activeId = () => useTabsStore.getState().activeId

/** a1 a2 | b1 b2 | c1, with each opened in that order (c1 active). */
function openThreeConnections(): Record<string, string> {
  const store = useTabsStore.getState()
  const opened: Record<string, string> = {}
  for (const [name, connectionId] of [
    ["a1", "a"],
    ["b1", "b"],
    ["a2", "a"],
    ["b2", "b"],
    ["c1", "c"],
  ]) {
    opened[name] = store.open(connectionId, null)
  }
  return opened
}

beforeEach(() => {
  useTabsStore.setState({ ...INITIAL_TABS })
})

describe("connection groups in the tabs store", () => {
  it("returns to each connection's last active tab", () => {
    const tab = openThreeConnections()
    const store = useTabsStore.getState()
    store.activate(tab.a1)
    store.activate(tab.b1)
    store.activateConnection("a")
    expect(activeId()).toBe(tab.a1)
    store.activateConnection("b")
    expect(activeId()).toBe(tab.b1)
    store.activateConnection("missing")
    expect(activeId()).toBe(tab.b1)
  })

  it("selects tabs of the active connection by slot, 9 being the last", () => {
    const tab = openThreeConnections()
    const store = useTabsStore.getState()
    store.activate(tab.b1)
    store.activateTabSlot(2)
    expect(activeId()).toBe(tab.b2)
    store.activateTabSlot(1)
    expect(activeId()).toBe(tab.b1)
    store.activateTabSlot(9)
    expect(activeId()).toBe(tab.b2)
    // Beyond the connection's tabs: nothing happens.
    store.activateTabSlot(3)
    expect(activeId()).toBe(tab.b2)
  })

  it("selects connection groups by slot, 9 being the last", () => {
    const tab = openThreeConnections()
    const store = useTabsStore.getState()
    store.activateConnectionSlot(1)
    expect(activeId()).toBe(tab.a2)
    store.activate(tab.a1)
    store.activateConnectionSlot(9)
    expect(activeId()).toBe(tab.c1)
    store.activateConnectionSlot(1)
    expect(activeId()).toBe(tab.a1)
    store.activateConnectionSlot(4)
    expect(activeId()).toBe(tab.a1)
  })

  it("moves to a neighbouring connection's remembered tab when the last tab closes", () => {
    const tab = openThreeConnections()
    const store = useTabsStore.getState()
    store.activate(tab.a1)
    store.activate(tab.c1)
    store.close(tab.c1)
    // c was the last group, so the previous group (b) takes over at its remembered tab.
    expect(activeId()).toBe(tab.b2)
    store.activate(tab.b1)
    store.close(tab.b1)
    expect(activeId()).toBe(tab.b2)
    store.close(tab.b2)
    expect(activeId()).toBe(tab.a1)
  })

  it("groups restored tabs together, keeping the order of the groups", () => {
    // Saved as a1 b1 a2 (by a version without groups); restore puts a's tabs together.
    const saved = [
      createTab("a1", "a", "Query 1", null),
      createTab("b1", "b", "Query 2", null),
      createTab("a2", "a", "Query 3", null),
    ]
    useTabsStore.getState().restore(saved, "a2", 3)
    expect(ids()).toEqual(["a1", "a2", "b1"])
    expect(useTabsStore.getState().recent).toEqual({ a: "a2" })
  })
})

describe("closeConnectionTabs", () => {
  it("closes every tab of a connection without asking when none holds unsaved work", () => {
    const tab = openThreeConnections()
    useTabsStore.getState().activate(tab.b1)
    closeConnectionTabs("b")
    expect(ids()).toEqual([tab.a1, tab.a2, tab.c1])
    expect(useTabsStore.getState().closingGroup).toBeNull()
    expect(activeId()).toBe(tab.c1)
  })

  it("asks once when a tab holds unsaved work, and closes all on confirm", () => {
    const tab = openThreeConnections()
    useTabsStore.getState().updateEdits(tab.b2, 0, () => toggleRowDelete(EMPTY_EDITS, 0))
    closeConnectionTabs("b")
    expect(useTabsStore.getState().closingGroup).toBe("b")
    expect(ids()).toHaveLength(5)

    cancelCloseGroup()
    expect(useTabsStore.getState().closingGroup).toBeNull()
    expect(ids()).toHaveLength(5)

    closeConnectionTabs("b")
    confirmCloseGroup()
    expect(ids()).toEqual([tab.a1, tab.a2, tab.c1])
    expect(useTabsStore.getState().closingGroup).toBeNull()
  })
})
