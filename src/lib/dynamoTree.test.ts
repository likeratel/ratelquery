import { describe, expect, it } from "vitest"
import type { AttributeValue } from "./dynamo"
import {
  copyValueText,
  DEFAULT_TREE_EXPANSION,
  EXPAND_LIMIT,
  expandAllDepth,
  isExpanded,
  isTable,
  MAX_TREE_DEPTH,
  memberOf,
  revealInTree,
  setAllExpanded,
  tableColumns,
  toggleExpanded,
  toggleTable,
  treeNode,
  type TreeValue,
} from "./dynamoTree"

const w = (value: AttributeValue): TreeValue => ({ kind: "wire", value })

const sender = (number: string, extra: Record<string, AttributeValue> = {}) => ({
  M: { senderNumber: { S: number }, ...extra },
})

describe("treeNode", () => {
  it("counts the members of maps, lists and sets", () => {
    const map = treeNode(w({ M: { a: { S: "x" }, b: { N: "1" } } }))
    expect(map).toMatchObject({ tag: "M", text: "2 keys", tone: "json" })
    expect(map.children?.map((c) => c.segment)).toEqual(["a", "b"])
    expect(treeNode(w({ L: [{ S: "x" }] }))).toMatchObject({ tag: "L", text: "1 item" })
    const set = treeNode(w({ NS: ["1", "2.50"] }))
    expect(set).toMatchObject({ tag: "NS", text: "2 items" })
    expect(set.children?.map((c) => c.value)).toEqual([w({ N: "1" }), w({ N: "2.50" })])
  })

  it("shows leaves like the grid and keeps numbers exact", () => {
    expect(treeNode(w({ N: "12345678901234567890.10" }))).toMatchObject({
      tag: "N",
      text: "12345678901234567890.10",
      tone: "number",
      children: null,
    })
    expect(treeNode(w({ NULL: true }))).toMatchObject({ text: "NULL", tone: "null" })
    expect(treeNode(w({ BOOL: false }))).toMatchObject({ text: "false", tone: "bool" })
    expect(treeNode(w({ B: "AAEC" }))).toMatchObject({ text: "(binary, 3 bytes)", tone: "bytes" })
    expect(treeNode(w({ S: "a\nb" }))).toMatchObject({ text: "a b", tone: "string", json: null })
  })

  it("opens JSON objects and arrays stored in strings", () => {
    const node = treeNode(w({ S: '{"a":[1,true,null,"x"]}' }))
    expect(node).toMatchObject({ tag: "S", text: "1 key", json: { compact: true } })
    const array = node.children?.[0].value
    expect(array).toEqual({ kind: "json", value: [1, true, null, "x"] })
    const inner = treeNode(array as TreeValue)
    expect(inner).toMatchObject({ tag: "array", text: "4 items" })
    expect(inner.children?.map((c) => treeNode(c.value).tag)).toEqual([
      "number",
      "bool",
      "null",
      "string",
    ])
  })

  it("leaves JSON with imprecise numbers closed, as a string", () => {
    const node = treeNode(w({ S: '{"id":12345678901234567890}' }))
    expect(node).toMatchObject({ children: null, json: { exact: false } })
    expect(node.text).toBe('{"id":12345678901234567890}')
  })
})

describe("copyValueText", () => {
  it("copies leaves as they are and containers as JSON", () => {
    expect(copyValueText(w({ S: "a b" }))).toBe("a b")
    expect(copyValueText(w({ N: "1.50" }))).toBe("1.50")
    expect(copyValueText(w({ BOOL: true }))).toBe("true")
    expect(copyValueText(w({ NULL: true }))).toBe("null")
    expect(copyValueText(w({ M: { a: { N: "1" } } }))).toBe('{\n  "a": 1\n}')
    // Plain JSON would turn the set into a list, so the wire form is copied.
    expect(copyValueText(w({ M: { a: { SS: ["x"] } } }))).toBe(
      '{\n  "M": {\n    "a": {\n      "SS": [\n        "x"\n      ]\n    }\n  }\n}',
    )
    expect(copyValueText({ kind: "json", value: "s" })).toBe("s")
    expect(copyValueText({ kind: "json", value: { a: 1 } })).toBe('{\n  "a": 1\n}')
  })
})

describe("tableColumns / memberOf", () => {
  it("joins the keys of two or more maps that share some", () => {
    const children = treeNode(
      w({ L: [sender("010", { on: { BOOL: true } }), sender("011", { label: { S: "b" } })] }),
    ).children
    expect(tableColumns(children ?? [])).toEqual(["senderNumber", "on", "label"])
    expect(memberOf(children?.[1].value as TreeValue, "label")).toEqual(w({ S: "b" }))
    expect(memberOf(children?.[1].value as TreeValue, "on")).toBeUndefined()
  })

  it("is null for one map, mixed lists and maps with nothing in common", () => {
    const columns = (value: AttributeValue) => tableColumns(treeNode(w(value)).children ?? [])
    expect(columns({ L: [sender("1")] })).toBeNull()
    expect(columns({ L: [sender("1"), { S: "x" }] })).toBeNull()
    expect(columns({ L: [{ M: { a: { S: "1" } } }, { M: { b: { S: "1" } } }] })).toBeNull()
    expect(
      tableColumns(treeNode({ kind: "json", value: [{ a: 1 }, { a: 2 }] }).children ?? []),
    ).toEqual(["a"])
  })
})

describe("expansion", () => {
  it("opens the first level by default, but not JSON in strings", () => {
    expect(isExpanded(DEFAULT_TREE_EXPANSION, ["senderService"], false)).toBe(true)
    expect(isExpanded(DEFAULT_TREE_EXPANSION, ["config"], true)).toBe(false)
    expect(isExpanded(DEFAULT_TREE_EXPANSION, ["senderService", "numbers"], false)).toBe(false)
  })

  it("remembers toggles by path until everything is expanded or collapsed", () => {
    let expansion = toggleExpanded(DEFAULT_TREE_EXPANSION, ["a", "b"], false)
    expansion = toggleExpanded(expansion, ["a"], false)
    expect(isExpanded(expansion, ["a", "b"], false)).toBe(true)
    expect(isExpanded(expansion, ["a"], false)).toBe(false)
    expect(DEFAULT_TREE_EXPANSION.open).toEqual({})

    const all = setAllExpanded(toggleTable(expansion, ["a", "b"]), true)
    expect(isExpanded(all, ["a"], false)).toBe(true)
    expect(isExpanded(all, ["x", 1, "config"], true)).toBe(true)
    expect(isTable(all, ["a", "b"])).toBe(true)
    expect(isExpanded(setAllExpanded(all, false), ["a"], false)).toBe(false)
  })

  it("follows a table cell back into the tree", () => {
    const table = toggleTable(DEFAULT_TREE_EXPANSION, ["s", "numbers"])
    const revealed = revealInTree(table, ["s", "numbers"], ["s", "numbers", 1, "meta"])
    expect(isTable(revealed, ["s", "numbers"])).toBe(false)
    for (const path of [
      ["s", "numbers"],
      ["s", "numbers", 1],
      ["s", "numbers", 1, "meta"],
    ]) {
      expect(isExpanded(revealed, path, false)).toBe(true)
    }
  })
})

describe("treeNode cache", () => {
  it("builds a value's node once, so rows and the find index share it", () => {
    const value = { S: '{"a":[1,2]}' }
    const node = treeNode(w(value))
    expect(treeNode(w(value))).toBe(node)
    const array = node.children?.[0].value
    expect(array && treeNode(array)).toBe(array && treeNode(array))
    // Equal values that are other objects get their own node.
    expect(treeNode(w({ S: '{"a":[1,2]}' }))).not.toBe(node)
    expect(treeNode(w({ S: '{"a":[1,2]}' }))).toEqual(node)
  })
})

describe("expand all on a large item", () => {
  const list = (n: number, member: (i: number) => AttributeValue) => ({
    L: Array.from({ length: n }, (_, i) => member(i)),
  })

  it("opens everything when every row fits", () => {
    const item = { pk: { S: "u1" }, m: { M: { a: list(3, () => ({ M: { x: { N: "1" } } })) } } }
    expect(expandAllDepth(item, ["pk", "m"], 20)).toBeNull()
    expect(expandAllDepth({}, [], 1)).toBeNull()
  })

  it("opens only the levels that fit in the limit", () => {
    // 2 attributes, then 1 + 0 members, then 10, then 10 x 5.
    const item = {
      pk: { S: "u1" },
      m: { M: { rows: list(10, () => list(5, (i) => ({ N: String(i) }))) } },
    }
    const names = ["pk", "m"]
    expect(expandAllDepth(item, names, 63)).toBeNull()
    expect(expandAllDepth(item, names, 62)).toBe(2)
    expect(expandAllDepth(item, names, 13)).toBe(2)
    expect(expandAllDepth(item, names, 12)).toBe(1)
    // The attributes' own members always open, as they do by default.
    expect(expandAllDepth(item, names, 2)).toBe(1)
  })

  it("counts the members of JSON stored in strings", () => {
    const json = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ i })))
    const item = { doc: { S: json } }
    expect(expandAllDepth(item, ["doc"], 61)).toBeNull()
    expect(expandAllDepth(item, ["doc"], 60)).toBe(1)
  })

  it("counts no rows below the deepest level the tree shows", () => {
    const depth = MAX_TREE_DEPTH + 100
    const item = { doc: { S: "[".repeat(depth) + "1" + "]".repeat(depth) } }
    expect(expandAllDepth(item, ["doc"], MAX_TREE_DEPTH)).toBeNull()
    expect(expandAllDepth(item, ["doc"], MAX_TREE_DEPTH - 1)).toBe(MAX_TREE_DEPTH - 2)
  })

  it("stops counting at the limit", () => {
    const item = { big: list(EXPAND_LIMIT * 5, (i) => ({ M: { i: { N: String(i) } } })) }
    expect(expandAllDepth(item, ["big"])).toBe(1)
  })

  it("keeps deeper rows closed under a depth, unless toggled open", () => {
    const bounded = { ...setAllExpanded(DEFAULT_TREE_EXPANSION, true), depth: 2 }
    expect(isExpanded(bounded, ["a"], false)).toBe(true)
    expect(isExpanded(bounded, ["a", 0], true)).toBe(true)
    expect(isExpanded(bounded, ["a", 0, "b"], false)).toBe(false)
    // A toggle follows what the tree shows, so the first click opens a bounded row.
    const stored = setAllExpanded(DEFAULT_TREE_EXPANSION, true)
    const toggled = toggleExpanded(stored, ["a", 0, "b"], false, bounded)
    expect(toggled.depth).toBeUndefined()
    expect(isExpanded({ ...toggled, depth: 2 }, ["a", 0, "b"], false)).toBe(true)
    expect(isExpanded({ ...toggled, depth: 2 }, ["a", 0, "c"], false)).toBe(false)
  })
})
