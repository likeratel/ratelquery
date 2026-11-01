import { describe, expect, it } from "vitest"
import { MAX_DISPLAY_CHARS } from "./cellFormat"
import type { AttributeValue, PathSegment } from "./dynamo"
import type { PendingAttribute, PendingItemEdit } from "./dynamoEdits"
import { pathKey } from "./dynamoPath"
import { MAX_TREE_DEPTH, treeNode, type TreeValue } from "./dynamoTree"
import {
  canEdit,
  editText,
  isChanged,
  isConflict,
  loadedJson,
  memberPlace,
  membersHost,
  numberSource,
  rowNode,
  shownLength,
  startsTreeEdit,
  treeFieldKey,
  type Place,
  type TreeEditView,
} from "./dynamoTreeView"

const w = (value: AttributeValue): TreeValue => ({ kind: "wire", value })
const j = (value: TreeValue["value"]): TreeValue => ({ kind: "json", value }) as TreeValue

const top = (name: string, keyRole: Place["keyRole"] = null): Place => ({
  path: [name],
  host: null,
  inSet: false,
  keyRole,
})

const change = (
  path: readonly PathSegment[],
  before: AttributeValue | null,
  after: AttributeValue,
): PendingAttribute => ({ path, before, after })

const editOf = (...changes: PendingAttribute[]): PendingItemEdit => ({
  key: { pk: { S: "u1" } },
  changes: Object.fromEntries(changes.map((c) => [pathKey(c.path), c])),
})

const view = (edit?: PendingItemEdit, conflicts: PendingAttribute[] = []): TreeEditView => ({
  edit,
  conflicts: new Set(conflicts),
  editable: true,
  loaded: loadedJson(edit),
})

/** The place and value of the member at `segments` below the top-level `name`. */
function placeAt(name: string, value: AttributeValue, segments: readonly PathSegment[]) {
  let place = top(name)
  let current: TreeValue = w(value)
  for (const segment of segments) {
    const node = treeNode(current)
    const child = node.children?.find((c) => c.segment === segment)
    if (!child) throw new Error(`no ${String(segment)}`)
    place = memberPlace(place, current, node, segment)
    current = child.value
  }
  return { place, value: current }
}

describe("memberPlace", () => {
  it("extends the path and keeps the key role", () => {
    const value = w({ M: { a: { S: "x" } } })
    const place = memberPlace(top("m", "sort"), value, treeNode(value), "a")
    expect(place).toEqual({ path: ["m", "a"], host: null, inSet: false, keyRole: "sort" })
  })

  it("marks set members, which have no document path", () => {
    expect(placeAt("s", { SS: ["a", "b"] }, [1]).place.inSet).toBe(true)
    expect(placeAt("l", { L: [{ S: "a" }] }, [0]).place.inSet).toBe(false)
  })

  it("puts JSON members in the string that holds them, with why it is read-only", () => {
    const compact = placeAt("doc", { S: '{"a":{"b":1}}' }, ["a", "b"]).place
    expect(compact.path).toEqual(["doc", "a", "b"])
    expect(compact.host).toEqual({ path: ["doc"], readOnly: null, numbers: new Map() })
    const spaced = placeAt("doc", { S: '{ "a": 1 }' }, ["a"]).place
    expect(spaced.host?.readOnly).toMatch(/compact/)
  })
})

describe("membersHost", () => {
  it("is the row itself when its string holds JSON, else the row's own host", () => {
    const value = w({ S: "[1]" })
    expect(membersHost(top("doc"), treeNode(value))).toEqual({
      path: ["doc"],
      readOnly: null,
      numbers: new Map(),
    })
    expect(membersHost(top("m"), treeNode(w({ M: {} })))).toBeNull()
  })
})

describe("rowNode", () => {
  it("shows a JSON number as its string stores it, and copies and searches it so", () => {
    const stored = { S: '{"big":1000000000000000000000,"small":1.50,"n":2}' }
    const big = placeAt("doc", stored, ["big"])
    expect(treeNode(big.value).text).toBe("1e+21")
    expect(rowNode(big.place, big.value).text).toBe("1000000000000000000000")
    expect(numberSource(big.place, big.value)).toBe("1000000000000000000000")
    expect(rowNode(...args(placeAt("doc", stored, ["small"]))).text).toBe("1.50")
    expect(rowNode(...args(placeAt("doc", stored, ["n"]))).text).toBe("2")
    // Such JSON isn't compact, so it stays read-only.
    expect(big.place.host?.readOnly).toMatch(/compact/)
    expect(numberSource(top("n"), w({ N: "1.50" }))).toBeUndefined()
  })

  it("shows a container at the deepest level as a summary without members", () => {
    const depth = MAX_TREE_DEPTH + 10
    const text = "[".repeat(depth) + "1" + "]".repeat(depth)
    const segments = Array.from({ length: MAX_TREE_DEPTH - 2 }, () => 0)
    const last = placeAt("doc", { S: text }, segments)
    expect(last.place.path).toHaveLength(MAX_TREE_DEPTH - 1)
    expect(rowNode(last.place, last.value).children).toHaveLength(1)
    const deepest = placeAt("doc", { S: text }, [...segments, 0])
    expect(deepest.place.path).toHaveLength(MAX_TREE_DEPTH)
    const node = rowNode(deepest.place, deepest.value)
    expect(node.children).toBeNull()
    expect(node.text).toBe("1 item, nested too deep to show")
    expect(canEdit(view(), deepest.place, deepest.value)).toBe(false)
  })
})

const args = ({ place, value }: { place: Place; value: TreeValue }) => [place, value] as const

describe("editText and shownLength", () => {
  it("starts a field with the stored value, not the displayed one", () => {
    expect(editText(w({ S: "a\nb" }))).toBe("a\nb")
    expect(editText(w({ N: "1.50" }))).toBe("1.50")
    expect(editText(w({ BOOL: false }))).toBe("false")
    expect(editText(j(2.5))).toBe("2.5")
    expect(editText(j("x"))).toBe("x")
    expect(editText(w({}))).toBe("")
  })

  it("counts the shown characters before the ellipsis of a long value", () => {
    const short = w({ S: "abc" })
    expect(shownLength(short, treeNode(short))).toBe(3)
    const long = w({ S: "x".repeat(MAX_DISPLAY_CHARS + 10) })
    expect(shownLength(long, treeNode(long))).toBe(MAX_DISPLAY_CHARS)
  })
})

describe("canEdit", () => {
  it("edits S, N and BOOL leaves of an editable item", () => {
    for (const value of [{ S: "a" }, { N: "1" }, { BOOL: true }]) {
      expect(canEdit(view(), top("a"), w(value))).toBe(true)
    }
    for (const value of [{ NULL: true as const }, { B: "AA==" }]) {
      expect(canEdit(view(), top("a"), w(value))).toBe(false)
    }
  })

  it("never edits keys, set members, a string holding JSON or a read-only item", () => {
    expect(canEdit(view(), top("pk", "partition"), w({ S: "a" }))).toBe(false)
    expect(canEdit({ ...view(), editable: false }, top("a"), w({ S: "a" }))).toBe(false)
    const member = placeAt("s", { SS: ["a"] }, [0])
    expect(canEdit(view(), member.place, member.value)).toBe(false)
    expect(canEdit(view(), top("doc"), w({ S: '{"a":1}' }))).toBe(false)
  })

  it("edits JSON scalars only inside compact JSON", () => {
    const compact = placeAt("doc", { S: '{"a":1,"b":[true],"c":null}' }, ["a"])
    expect(canEdit(view(), compact.place, compact.value)).toBe(true)
    const nul = placeAt("doc", { S: '{"a":1,"b":[true],"c":null}' }, ["c"])
    expect(canEdit(view(), nul.place, nul.value)).toBe(false)
    const spaced = placeAt("doc", { S: '{ "a": 1 }' }, ["a"])
    expect(canEdit(view(), spaced.place, spaced.value)).toBe(false)
  })
})

describe("loadedJson", () => {
  it("parses each pending string once, as it was loaded", () => {
    const edit = editOf(
      change(["doc"], { S: '{"a":1}' }, { S: '{"a":2}' }),
      change(["plain"], { S: "text" }, { S: "more" }),
      change(["n"], { N: "1" }, { N: "2" }),
      change(["new"], null, { S: "x" }),
    )
    const loaded = loadedJson(edit)
    expect(loaded.get(pathKey(["doc"]))?.value).toEqual({ a: 1 })
    expect(loaded.get(pathKey(["plain"]))).toBeNull()
    expect(loaded.has(pathKey(["n"]))).toBe(false)
    expect(loaded.has(pathKey(["new"]))).toBe(false)
    expect(loadedJson(undefined).size).toBe(0)
  })
})

describe("isChanged and isConflict", () => {
  it("marks a value with a pending change at its path", () => {
    const edit = editOf(change(["a"], { S: "x" }, { S: "y" }))
    expect(isChanged(view(edit), top("a"), w({ S: "y" }))).toBe(true)
    expect(isChanged(view(edit), top("b"), w({ S: "y" }))).toBe(false)
    expect(isChanged(view(), top("a"), w({ S: "y" }))).toBe(false)
  })

  it("marks only the JSON leaves that differ from the string as loaded", () => {
    const before = { S: '{"a":1,"b":2}' }
    const after = { S: '{"a":1,"b":3}' }
    const edit = editOf(change(["doc"], before, after))
    const a = placeAt("doc", after, ["a"])
    const b = placeAt("doc", after, ["b"])
    expect(isChanged(view(edit), a.place, a.value)).toBe(false)
    expect(isChanged(view(edit), b.place, b.value)).toBe(true)
    // Without a change at the string, nothing inside it is marked.
    expect(isChanged(view(), b.place, b.value)).toBe(false)
  })

  it("marks every JSON leaf when the string no longer held JSON", () => {
    const edit = editOf(change(["doc"], { S: "plain" }, { S: '{"a":1}' }))
    const a = placeAt("doc", { S: '{"a":1}' }, ["a"])
    expect(isChanged(view(edit), a.place, a.value)).toBe(true)
  })

  it("reports a conflict at the value, or at the string that holds a JSON value", () => {
    const stale = change(["doc"], { S: '{"a":1}' }, { S: '{"a":2}' })
    const edit = editOf(stale, change(["n"], { N: "1" }, { N: "2" }))
    const a = placeAt("doc", { S: '{"a":2}' }, ["a"])
    expect(isConflict(view(edit, [stale]), a.place)).toBe(true)
    expect(isConflict(view(edit, [stale]), top("n"))).toBe(false)
    expect(isConflict(view(edit), a.place)).toBe(false)
  })
})

const press = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "shift" | "alt" | "composing", boolean>> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  isComposing: mods.composing ?? false,
})

describe("startsTreeEdit", () => {
  it("opens a value's field on bare Enter, keypad Enter and F2", () => {
    for (const mac of [true, false]) {
      expect(startsTreeEdit(press("Enter"), mac)).toBe(true)
      expect(startsTreeEdit(press("NumpadEnter"), mac)).toBe(true)
      expect(startsTreeEdit(press("F2"), mac)).toBe(true)
    }
  })

  it("leaves Enter with a modifier to the app, so Run still fires", () => {
    expect(startsTreeEdit(press("Enter", { meta: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { ctrl: true }), false)).toBe(false)
    expect(startsTreeEdit(press("Enter", { ctrl: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { meta: true, shift: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { shift: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { alt: true }), true)).toBe(false)
    expect(startsTreeEdit(press("F2", { meta: true }), true)).toBe(false)
    expect(startsTreeEdit(press("F2", { shift: true }), false)).toBe(false)
  })

  it("leaves a key that ends an IME composition to the IME", () => {
    expect(startsTreeEdit(press("Enter", { composing: true }), true)).toBe(false)
    expect(startsTreeEdit(press("F2", { composing: true }), true)).toBe(false)
  })

  it("ignores other keys", () => {
    expect(startsTreeEdit(press("KeyE"), true)).toBe(false)
    expect(startsTreeEdit(press("Space"), true)).toBe(false)
  })
})

describe("treeFieldKey", () => {
  it("commits on bare Enter and cancels on Esc", () => {
    for (const mac of [true, false]) {
      expect(treeFieldKey(press("Enter"), mac)).toBe("commit")
      expect(treeFieldKey(press("NumpadEnter"), mac)).toBe("commit")
      expect(treeFieldKey(press("Escape"), mac)).toBe("cancel")
    }
  })

  it("never commits or closes the field while a Korean or Japanese composition is open", () => {
    expect(treeFieldKey(press("Enter", { composing: true }), true)).toBe("composing")
    expect(treeFieldKey(press("NumpadEnter", { composing: true }), false)).toBe("composing")
    expect(treeFieldKey(press("Escape", { composing: true }), true)).toBe("composing")
  })

  it("leaves Enter with Mod or Ctrl held to the app's shortcuts", () => {
    expect(treeFieldKey(press("Enter", { meta: true }), true)).toBeNull()
    expect(treeFieldKey(press("Enter", { ctrl: true }), true)).toBeNull()
    expect(treeFieldKey(press("Enter", { ctrl: true }), false)).toBeNull()
    expect(treeFieldKey(press("Enter", { meta: true }), false)).toBeNull()
    expect(treeFieldKey(press("Enter", { meta: true, shift: true }), true)).toBeNull()
    expect(treeFieldKey(press("Escape", { meta: true }), true)).toBeNull()
  })

  it("ignores typing", () => {
    expect(treeFieldKey(press("KeyA"), true)).toBeNull()
    expect(treeFieldKey(press("KeyA", { shift: true }), true)).toBeNull()
  })
})
