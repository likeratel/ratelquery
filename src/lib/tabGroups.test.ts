import { describe, expect, it } from "vitest"
import {
  activeConnectionId,
  forgetRecent,
  groupedOrder,
  groupTabIds,
  insertTab,
  nextActiveAfterClose,
  rememberActive,
  rememberedTab,
  slotGroupTab,
  slotItem,
  slotTab,
  tabGroups,
} from "./tabGroups"

const tab = (id: string, connectionId: string) => ({ id, connectionId })

// a1 a2 | b1 | c1 c2
const tabs = [tab("a1", "a"), tab("a2", "a"), tab("b1", "b"), tab("c1", "c"), tab("c2", "c")]
const state = (activeId: string | null, recent: Record<string, string> = {}) => ({
  tabs,
  activeId,
  recent,
})

describe("tabGroups", () => {
  it("groups tabs by connection in order of first appearance", () => {
    const mixed = [tab("b1", "b"), tab("a1", "a"), tab("b2", "b")]
    expect(tabGroups(mixed)).toEqual([
      { connectionId: "b", tabIds: ["b1", "b2"] },
      { connectionId: "a", tabIds: ["a1"] },
    ])
    expect(tabGroups([])).toEqual([])
    expect(groupTabIds(mixed, "b")).toEqual(["b1", "b2"])
    expect(groupTabIds(mixed, "zzz")).toEqual([])
  })

  it("puts each group's tabs together without reordering the groups", () => {
    const mixed = [tab("b1", "b"), tab("a1", "a"), tab("b2", "b")]
    expect(groupedOrder(mixed).map((t) => t.id)).toEqual(["b1", "b2", "a1"])
    expect(mixed.map((t) => t.id)).toEqual(["b1", "a1", "b2"])
  })

  it("inserts a tab after its connection's last tab, or at the end", () => {
    expect(insertTab(tabs, tab("a3", "a")).map((t) => t.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
      "c1",
      "c2",
    ])
    expect(insertTab(tabs, tab("d1", "d")).at(-1)?.id).toBe("d1")
    expect(tabs).toHaveLength(5)
  })

  it("finds the active connection", () => {
    expect(activeConnectionId(state("b1"))).toBe("b")
    expect(activeConnectionId(state(null))).toBeNull()
    expect(activeConnectionId(state("gone"))).toBeNull()
  })
})

describe("remembered tabs", () => {
  it("records the active tab under its connection", () => {
    const remembered = rememberActive(state("a1", { c: "c1" }))
    expect(remembered.recent).toEqual({ a: "a1", c: "c1" })
    expect(rememberActive(remembered)).toBe(remembered)
    const none = state(null)
    expect(rememberActive(none)).toBe(none)
  })

  it("falls back to the connection's last tab when nothing valid is remembered", () => {
    expect(rememberedTab(state("a1", { c: "c1" }), "c")).toBe("c1")
    expect(rememberedTab(state("a1"), "c")).toBe("c2")
    expect(rememberedTab(state("a1", { c: "closed" }), "c")).toBe("c2")
    expect(rememberedTab(state("a1"), "zzz")).toBeNull()
  })

  it("forgets a closed tab", () => {
    const recent = { a: "a1", b: "b1" }
    expect(forgetRecent(recent, "a1")).toEqual({ b: "b1" })
    expect(forgetRecent(recent, "zzz")).toBe(recent)
  })
})

describe("slots", () => {
  it("picks positions 1-8 and makes 9 the last", () => {
    const items = ["x", "y", "z"]
    expect(slotItem(items, 1)).toBe("x")
    expect(slotItem(items, 3)).toBe("z")
    expect(slotItem(items, 4)).toBeNull()
    expect(slotItem(items, 8)).toBeNull()
    expect(slotItem(items, 9)).toBe("z")
    expect(slotItem([], 9)).toBeNull()
    expect(slotItem(items, 0)).toBeNull()
    expect(slotItem(items, 10)).toBeNull()
  })

  it("picks tabs within the active connection only", () => {
    expect(slotTab(state("c1"), 1)).toBe("c1")
    expect(slotTab(state("c1"), 2)).toBe("c2")
    expect(slotTab(state("c1"), 3)).toBeNull()
    expect(slotTab(state("c1"), 9)).toBe("c2")
    expect(slotTab(state("b1"), 9)).toBe("b1")
    expect(slotTab(state(null), 1)).toBeNull()
  })

  it("picks connection groups and lands on their remembered tab", () => {
    expect(slotGroupTab(state("a2", { c: "c1" }), 3)).toBe("c1")
    expect(slotGroupTab(state("a2"), 3)).toBe("c2")
    expect(slotGroupTab(state("c1", { a: "a1" }), 1)).toBe("a1")
    expect(slotGroupTab(state("a1"), 9)).toBe("c2")
    expect(slotGroupTab(state("a1"), 4)).toBeNull()
  })
})

describe("nextActiveAfterClose", () => {
  it("stays on the same connection while it has tabs", () => {
    expect(nextActiveAfterClose(state("a1"), "a1")).toBe("a2")
    expect(nextActiveAfterClose(state("a2"), "a2")).toBe("a1")
    expect(nextActiveAfterClose(state("c2"), "c2")).toBe("c1")
  })

  it("moves to the next connection's remembered tab, else the previous one", () => {
    expect(nextActiveAfterClose(state("b1", { c: "c1" }), "b1")).toBe("c1")
    expect(nextActiveAfterClose(state("b1"), "b1")).toBe("c2")
    const lastGroup = { tabs: [tab("a1", "a"), tab("b1", "b")], activeId: "b1", recent: {} }
    expect(nextActiveAfterClose(lastGroup, "b1")).toBe("a1")
    const only = { tabs: [tab("a1", "a")], activeId: "a1", recent: {} }
    expect(nextActiveAfterClose(only, "a1")).toBeNull()
  })
})
