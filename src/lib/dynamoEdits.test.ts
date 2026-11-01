import { describe, expect, it } from "vitest"
import type { Item, KeySchema, PathSegment } from "./dynamo"
import {
  buildItemUpdates,
  carriedExpectations,
  changesUnder,
  conflictingChanges,
  EMPTY_DYNAMO_EDITS,
  failedEditHint,
  inlineEditType,
  itemEdit,
  keyId,
  keyLabel,
  markFailed,
  parseDynamoNumber,
  parseInlineValue,
  parseJsonLeaf,
  pendingChangeList,
  pendingEditCount,
  stageCellEdit,
  stageTreeEdit,
  withoutItems,
  withPendingValues,
  type DynamoEdits,
} from "./dynamoEdits"
import { pathKey } from "./dynamoPath"

const schema: KeySchema = { hash: { name: "pk", type: "S" }, range: { name: "sk", type: "N" } }

const item: Item = {
  pk: { S: "u1" },
  sk: { N: "1" },
  name: { S: "Ada" },
  age: { N: "36" },
  active: { BOOL: true },
  gone: { NULL: true },
  tags: { SS: ["a"] },
}

function stage(edits: DynamoEdits, name: string, text: string, from: Item = item): DynamoEdits {
  const result = stageCellEdit(edits, { item: from, schema, name, text })
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/** The pending change of the test item at `path`. */
const changeAt = (edits: DynamoEdits, ...path: PathSegment[]) =>
  itemEdit(edits, item, schema)?.changes[pathKey(path)]

describe("inlineEditType", () => {
  it("allows scalar non-key attributes and missing ones", () => {
    expect(inlineEditType({ S: "a" }, null)).toBe("S")
    expect(inlineEditType({ N: "1" }, null)).toBe("N")
    expect(inlineEditType({ BOOL: false }, null)).toBe("BOOL")
    expect(inlineEditType(undefined, null)).toBe("S")
  })

  it("sends keys, NULL, binary and nested values to the JSON editor", () => {
    expect(inlineEditType({ S: "a" }, "partition")).toBeNull()
    expect(inlineEditType({ N: "1" }, "sort")).toBeNull()
    for (const value of [{ NULL: true }, { B: "AA==" }, { M: {} }, { L: [] }, { SS: ["a"] }]) {
      expect(inlineEditType(value, null)).toBeNull()
    }
  })
})

describe("parseDynamoNumber", () => {
  it("accepts decimal numbers within DynamoDB's limits", () => {
    for (const text of [
      "0",
      "-12",
      " 3.50 ",
      "1e125",
      "1E-130",
      "12345678901234567890123456789012345678",
    ]) {
      expect(parseDynamoNumber(text)).toEqual({ ok: true, value: text.trim() })
    }
  })

  it("rejects text, too many digits and out-of-range magnitudes", () => {
    for (const text of ["", "abc", "1..2", "0x10", "Infinity"]) {
      expect(parseDynamoNumber(text).ok).toBe(false)
    }
    expect(parseDynamoNumber("123456789012345678901234567890123456789").ok).toBe(false)
    expect(parseDynamoNumber("1e126").ok).toBe(false)
    expect(parseDynamoNumber("1e-131").ok).toBe(false)
  })
})

describe("parseInlineValue", () => {
  it("keeps the attribute's type", () => {
    expect(parseInlineValue("S", "")).toEqual({ ok: true, value: { S: "" } })
    expect(parseInlineValue("S", " x ")).toEqual({ ok: true, value: { S: " x " } })
    expect(parseInlineValue("N", "42")).toEqual({ ok: true, value: { N: "42" } })
    expect(parseInlineValue("BOOL", " False ")).toEqual({ ok: true, value: { BOOL: false } })
    expect(parseInlineValue("BOOL", "yes").ok).toBe(false)
    expect(parseInlineValue("N", "forty").ok).toBe(false)
  })
})

describe("stageCellEdit", () => {
  it("records the starting value and the new one, keyed by the item key", () => {
    const edits = stage(stage(EMPTY_DYNAMO_EDITS, "name", "Grace"), "age", "37")
    const id = keyId({ pk: { S: "u1" }, sk: { N: "1" } })
    expect(Object.keys(edits)).toEqual([id])
    expect(Object.values(edits[id].changes)).toEqual([
      { path: ["name"], before: { S: "Ada" }, after: { S: "Grace" } },
      { path: ["age"], before: { N: "36" }, after: { N: "37" } },
    ])
    expect(pendingEditCount(edits)).toBe(2)
  })

  it("unstages a value edited back to where it started", () => {
    const edits = stage(stage(EMPTY_DYNAMO_EDITS, "age", "37"), "age", "36.0")
    expect(edits).toEqual(EMPTY_DYNAMO_EDITS)
  })

  it("keeps the first starting value across repeated edits and refreshed items", () => {
    const refreshed = { ...item, name: { S: "Changed elsewhere" } }
    const edits = stage(stage(EMPTY_DYNAMO_EDITS, "name", "Grace"), "name", "Lin", refreshed)
    expect(changeAt(edits, "name")).toEqual({
      path: ["name"],
      before: { S: "Ada" },
      after: { S: "Lin" },
    })
  })

  it("adds a missing attribute as a string, and leaves it missing when left empty", () => {
    expect(stage(EMPTY_DYNAMO_EDITS, "note", "")).toEqual(EMPTY_DYNAMO_EDITS)
    const edits = stage(EMPTY_DYNAMO_EDITS, "note", "hi")
    expect(changeAt(edits, "note")).toEqual({
      path: ["note"],
      before: null,
      after: { S: "hi" },
    })
    expect(stage(edits, "note", "")).toEqual(EMPTY_DYNAMO_EDITS)
  })

  it("stages an emptied string as an empty string", () => {
    const edits = stage(EMPTY_DYNAMO_EDITS, "name", "")
    expect(changeAt(edits, "name")?.after).toEqual({ S: "" })
  })

  it("refuses invalid input, keys, non-scalar attributes and items without a key", () => {
    const attempt = (name: string, text: string, from: Item = item) =>
      stageCellEdit(EMPTY_DYNAMO_EDITS, { item: from, schema, name, text })
    expect(attempt("age", "x").ok).toBe(false)
    expect(attempt("active", "maybe").ok).toBe(false)
    expect(attempt("pk", "u2").ok).toBe(false)
    expect(attempt("sk", "2").ok).toBe(false)
    expect(attempt("gone", "x").ok).toBe(false)
    expect(attempt("tags", "x").ok).toBe(false)
    expect(attempt("name", "x", { name: { S: "no key" } }).ok).toBe(false)
  })

  it("does not mutate the previous edits", () => {
    const first = stage(EMPTY_DYNAMO_EDITS, "name", "Grace")
    const snapshot = JSON.stringify(first)
    stage(first, "age", "1")
    stage(first, "name", "Ada")
    expect(JSON.stringify(first)).toBe(snapshot)
  })
})

describe("withPendingValues / buildItemUpdates / withoutItems", () => {
  const other: Item = { pk: { S: "u2" }, sk: { N: "1" }, active: { BOOL: false } }
  const edits = stage(
    stage(stage(EMPTY_DYNAMO_EDITS, "name", "Grace"), "active", "true", other),
    "note",
    "n",
  )

  it("overlays pending values for display", () => {
    const shown = withPendingValues(item, itemEdit(edits, item, schema))
    expect(shown.name).toEqual({ S: "Grace" })
    expect(shown.note).toEqual({ S: "n" })
    expect(shown.age).toEqual({ N: "36" })
    expect(withPendingValues(item, undefined)).toBe(item)
  })

  it("builds one conditional update per item", () => {
    const updates = buildItemUpdates(edits)
    expect(updates).toHaveLength(2)
    expect(updates[0].key).toEqual({ pk: { S: "u1" }, sk: { N: "1" } })
    expect(updates[0].changes).toEqual([
      { name: "name", value: { S: "Grace" }, expected: { S: "Ada" } },
      { name: "note", value: { S: "n" }, expected: null },
    ])
    expect(updates[1].changes).toEqual([
      { name: "active", value: { BOOL: true }, expected: { BOOL: false } },
    ])
  })

  it("drops the given items only", () => {
    const [first, second] = buildItemUpdates(edits)
    const left = withoutItems(edits, [first.id])
    expect(Object.keys(left)).toEqual([second.id])
    expect(withoutItems(edits, ["missing"])).toBe(edits)
  })
})

describe("failed items", () => {
  it("marks only the failed items and picks the hint by error kind", () => {
    const edits: DynamoEdits = {
      a: { key: { pk: { S: "a" } }, changes: {} },
      b: { key: { pk: { S: "b" } }, changes: {} },
    }
    const marked = markFailed(edits, { b: "query" })
    expect(marked.a).toBe(edits.a)
    expect(marked.b).toEqual({ ...edits.b, failed: "query" })
    expect(failedEditHint("query")).toMatch(/changed on the server/)
    expect(failedEditHint("connection")).toMatch(/couldn't be reached/)
    expect(failedEditHint("unknown")).toMatch(/^Not written\. /)
  })
})

describe("keyLabel", () => {
  it("names an item by its key values", () => {
    expect(keyLabel({ pk: { S: "u1" }, sk: { N: "2" } })).toBe('pk="u1", sk=2')
  })
})

describe("stageTreeEdit", () => {
  const sender = (number: string, on = false) => ({
    M: { senderNumber: { S: number }, on: { BOOL: on }, n: { N: "1" } },
  })
  const nested: Item = {
    pk: { S: "u1" },
    sk: { N: "1" },
    senderService: { M: { numbers: { L: [sender("010"), sender("011")] } } },
    config: { S: '{"theme":{"dark":true},"size":12,"tags":["a"]}' },
    pretty: { S: '{ "a": 1 }' },
    big: { S: '{"id":12345678901234567890}' },
    note: { S: "plain" },
    nothing: { NULL: true },
  }
  const tree = (
    edits: DynamoEdits,
    path: PathSegment[],
    text: string,
    jsonPath: PathSegment[] = [],
  ) => stageTreeEdit(edits, { item: nested, schema, path, jsonPath, text })
  const staged = (...args: Parameters<typeof tree>) => {
    const result = tree(...args)
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  const numberPath = ["senderService", "numbers", 1, "senderNumber"]

  it("stages a nested scalar with the value it started from", () => {
    const edits = staged(EMPTY_DYNAMO_EDITS, numberPath, "012")
    const edit = itemEdit(edits, nested, schema)
    expect(Object.values(edit?.changes ?? {})).toEqual([
      {
        path: numberPath,
        before: { S: "011" },
        after: { S: "012" },
        // The list the path indexes into, whole, as loaded.
        guards: [
          { path: ["senderService", "numbers"], value: { L: [sender("010"), sender("011")] } },
        ],
      },
    ])
    const shown = withPendingValues(nested, edit)
    expect(shown.senderService).toEqual({
      M: {
        numbers: { L: [sender("010"), { M: { ...sender("011").M, senderNumber: { S: "012" } } }] },
      },
    })
    // The loaded item is left alone.
    expect(nested.senderService).toEqual({ M: { numbers: { L: [sender("010"), sender("011")] } } })
    expect(changesUnder(edit, ["senderService", "numbers"])).toHaveLength(1)
    expect(changesUnder(edit, ["senderService", "numbers", 0])).toHaveLength(0)
  })

  it("validates numbers and booleans like the grid, and unstages a value set back", () => {
    expect(tree(EMPTY_DYNAMO_EDITS, ["senderService", "numbers", 0, "n"], "x")).toEqual({
      ok: false,
      error: '"x" isn\'t a number',
    })
    expect(tree(EMPTY_DYNAMO_EDITS, ["senderService", "numbers", 0, "on"], "yes").ok).toBe(false)
    const edits = staged(EMPTY_DYNAMO_EDITS, ["senderService", "numbers", 0, "n"], "2")
    expect(staged(edits, ["senderService", "numbers", 0, "n"], "1.0")).toEqual(EMPTY_DYNAMO_EDITS)
  })

  it("refuses a value under an empty map key, which an update path can't name", () => {
    const keyed: Item = {
      pk: { S: "u1" },
      sk: { N: "1" },
      m: { M: { "": { M: { a: { S: "x" } } }, b: { S: '{"":{"c":1}}' } } },
    }
    const stage = (path: PathSegment[], text: string, jsonPath: PathSegment[] = []) =>
      stageTreeEdit(EMPTY_DYNAMO_EDITS, { item: keyed, schema, path, jsonPath, text })
    const refused = stage(["m", "", "a"], "y")
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error).toMatch(/empty map key/)
    // An empty key inside JSON stored in a string is only text, and is fine.
    expect(stage(["m", "b"], "2", ["", "c"]).ok).toBe(true)
  })

  it("refuses keys, containers, NULL and values that are gone", () => {
    expect(tree(EMPTY_DYNAMO_EDITS, ["pk"], "u2").ok).toBe(false)
    expect(tree(EMPTY_DYNAMO_EDITS, ["senderService", "numbers"], "x").ok).toBe(false)
    expect(tree(EMPTY_DYNAMO_EDITS, ["nothing"], "x").ok).toBe(false)
    expect(tree(EMPTY_DYNAMO_EDITS, ["senderService", "numbers", 5, "n"], "1")).toEqual({
      ok: false,
      error: "This value is no longer in the item",
    })
  })

  it("rewrites a compact JSON string as JSON.stringify of the edited value", () => {
    let edits = staged(EMPTY_DYNAMO_EDITS, ["config"], "false", ["theme", "dark"])
    edits = staged(edits, ["config"], "13", ["size"])
    edits = staged(edits, ["config"], "b", ["tags", 0])
    expect(Object.values(itemEdit(edits, nested, schema)?.changes ?? {})).toEqual([
      {
        path: ["config"],
        before: nested.config,
        after: { S: '{"theme":{"dark":false},"size":13,"tags":["b"]}' },
      },
    ])
    // Back to the loaded text: nothing is pending.
    edits = staged(edits, ["config"], "true", ["theme", "dark"])
    edits = staged(edits, ["config"], "12", ["size"])
    expect(staged(edits, ["config"], "a", ["tags", 0])).toEqual(EMPTY_DYNAMO_EDITS)
  })

  it("keeps JSON numbers exact and leaves non-compact or imprecise JSON read-only", () => {
    expect(tree(EMPTY_DYNAMO_EDITS, ["config"], "9007199254740993", ["size"])).toEqual({
      ok: false,
      error: "9007199254740993 can't be stored exactly in JSON",
    })
    expect(tree(EMPTY_DYNAMO_EDITS, ["pretty"], "2", ["a"])).toEqual({
      ok: false,
      error: "Not compact JSON, so an edit would reformat it",
    })
    expect(tree(EMPTY_DYNAMO_EDITS, ["big"], "1", ["id"]).ok).toBe(false)
    expect(tree(EMPTY_DYNAMO_EDITS, ["note"], "x", ["a"]).ok).toBe(false)
    expect(tree(EMPTY_DYNAMO_EDITS, ["config"], "x", ["theme"]).ok).toBe(false)
  })

  it("shares one change with the grid cell of the same attribute", () => {
    const fromTree = staged(EMPTY_DYNAMO_EDITS, ["config"], "1", ["size"])
    const fromGrid = stageCellEdit(fromTree, { item: nested, schema, name: "config", text: "{}" })
    if (!fromGrid.ok) throw new Error(fromGrid.error)
    expect(Object.values(itemEdit(fromGrid.value, nested, schema)?.changes ?? {})).toEqual([
      { path: ["config"], before: nested.config, after: { S: "{}" } },
    ])
  })

  it("sends nested changes with their path below the attribute", () => {
    const edits = staged(staged(EMPTY_DYNAMO_EDITS, numberPath, "012"), ["note"], "p")
    const [update] = buildItemUpdates(edits)
    expect(update.changes).toEqual([
      {
        name: "senderService",
        path: ["numbers", 1, "senderNumber"],
        value: { S: "012" },
        expected: { S: "011" },
      },
      { name: "note", value: { S: "p" }, expected: { S: "plain" } },
    ])
    expect(buildItemUpdates(edits, ["other"])).toEqual([])
  })
})

describe("parseJsonLeaf", () => {
  it("parses strings as typed, booleans and exact numbers", () => {
    expect(parseJsonLeaf("string", " a ")).toEqual({ ok: true, value: " a " })
    expect(parseJsonLeaf("boolean", "TRUE")).toEqual({ ok: true, value: true })
    expect(parseJsonLeaf("number", " 1.50 ")).toEqual({ ok: true, value: 1.5 })
    expect(parseJsonLeaf("number", "1e400").ok).toBe(false)
    expect(parseJsonLeaf("number", "abc").ok).toBe(false)
  })
})

describe("pendingChangeList", () => {
  it("names each change by its path for the review", () => {
    const edits = stage(stage(EMPTY_DYNAMO_EDITS, "name", "Grace"), "note", "n")
    expect(pendingChangeList(itemEdit(edits, item, schema))).toEqual([
      {
        name: "name",
        id: '["name"]',
        kind: "changed",
        before: { S: "Ada" },
        after: { S: "Grace" },
      },
      { name: "note", id: '["note"]', kind: "added", before: null, after: { S: "n" } },
    ])
    expect(pendingChangeList(undefined)).toEqual([])
  })
})

describe("list guards and conflicts", () => {
  const rule = (id: string, on = false) => ({ M: { id: { S: id }, on: { BOOL: on } } })
  const loaded: Item = { pk: { S: "u1" }, sk: { N: "1" }, rules: { L: [rule("r1"), rule("r2")] } }
  const shifted: Item = { ...loaded, rules: { L: [rule("r2")] } }
  const edit = (edits: DynamoEdits, path: PathSegment[], text: string, from = loaded) => {
    const result = stageTreeEdit(edits, { item: from, schema, path, jsonPath: [], text })
    if (!result.ok) throw new Error(result.error)
    return result.value
  }

  it("guards each list on the path once, as first loaded", () => {
    let edits = edit(EMPTY_DYNAMO_EDITS, ["rules", 0, "on"], "true")
    // A later edit in the same list, made after a refresh, keeps the first guard.
    edits = edit(edits, ["rules", 0, "id"], "x", shifted)
    const [update] = buildItemUpdates(edits)
    expect(update.expected).toEqual([{ name: "rules", value: loaded.rules }])
  })

  it("flags changes a shifted list no longer matches instead of laying them over it", () => {
    const edits = edit(EMPTY_DYNAMO_EDITS, ["rules", 0, "on"], "true")
    const pending = itemEdit(edits, loaded, schema)
    expect(conflictingChanges(pending, loaded)).toEqual([])
    // The leaf at rules[0].on is still false, but it belongs to r2 now.
    expect(conflictingChanges(pending, shifted)).toHaveLength(1)
    expect(withPendingValues(shifted, pending)).toEqual(shifted)
    expect(withPendingValues(loaded, pending).rules).toEqual({ L: [rule("r1", true), rule("r2")] })
  })

  it("flags changes whose path leads nowhere or whose value changed", () => {
    const edits = edit(EMPTY_DYNAMO_EDITS, ["rules", 1, "on"], "true")
    const pending = itemEdit(edits, loaded, schema)
    expect(conflictingChanges(pending, shifted)).toHaveLength(1)
    const changed = { ...loaded, rules: { L: [rule("r1"), rule("r2", true)] } }
    expect(conflictingChanges(pending, changed)).toHaveLength(1)
    // A grid edit of a missing attribute conflicts once the attribute appears.
    const added = stage(EMPTY_DYNAMO_EDITS, "note", "n")
    expect(
      conflictingChanges(itemEdit(added, item, schema), { ...item, note: { S: "x" } }),
    ).toHaveLength(1)
  })

  it("carries each starting value and list on its path to the item editor", () => {
    const edits = stage(edit(EMPTY_DYNAMO_EDITS, ["rules", 0, "on"], "true"), "note", "n", loaded)
    expect(carriedExpectations(Object.values(edits)[0])).toEqual([
      { name: "rules", path: [0, "on"], value: { BOOL: false } },
      { name: "note", value: null },
      { name: "rules", value: loaded.rules },
    ])
  })

  it("guards the list of an index in the middle of the path, even among equal maps", () => {
    const off = { M: { on: { BOOL: false } } }
    const rules: Item = { ...loaded, rules: { L: [{ M: { id: { S: "a" } } }, off, off] } }
    const edits = edit(EMPTY_DYNAMO_EDITS, ["rules", 1, "on"], "true", rules)
    expect(buildItemUpdates(edits)[0].expected).toEqual([{ name: "rules", value: rules.rules }])
    // `rules[0]` removed: index 1 still holds an equal map with `on: false`, but not the same one.
    const shiftedRules = { ...rules, rules: { L: [off, off] } }
    const pending = itemEdit(edits, rules, schema)
    expect(conflictingChanges(pending, shiftedRules)).toHaveLength(1)
    expect(withPendingValues(shiftedRules, pending)).toEqual(shiftedRules)
  })

  it("guards every list on a path with two indexes", () => {
    const c = (v: string) => ({ M: { c: { S: v } } })
    const b = (...cs: string[]) => ({ M: { b: { L: cs.map(c) } } })
    const nested: Item = { ...loaded, a: { L: [b("x", "x"), b("y")] } }
    const edits = edit(EMPTY_DYNAMO_EDITS, ["a", 0, "b", 1, "c"], "z", nested)
    expect(buildItemUpdates(edits)[0].expected).toEqual([
      { name: "a", value: nested.a },
      { name: "a", path: [0, "b"], value: b("x", "x").M.b },
    ])
    const pending = itemEdit(edits, nested, schema)
    // A shift of the outer list, or of the inner one, is a conflict.
    const outer = { ...nested, a: { L: [b("x", "x")] } }
    const inner = { ...nested, a: { L: [{ M: { b: { L: [c("w"), c("x"), c("x")] } } }, b("y")] } }
    expect(conflictingChanges(pending, outer)).toHaveLength(1)
    expect(conflictingChanges(pending, inner)).toHaveLength(1)
    expect(conflictingChanges(pending, nested)).toEqual([])
  })

  it("keeps the failure mark through later edits", () => {
    const edits = stage(EMPTY_DYNAMO_EDITS, "name", "Grace")
    const failed = markFailed(edits, { [Object.keys(edits)[0]]: "connection" })
    expect(Object.values(stage(failed, "age", "40"))[0].failed).toBe("connection")
    expect(Object.values(stage(failed, "name", "Ada"))).toEqual([])
  })

  it("refuses an edit inside JSON the item now holds in non-compact form", () => {
    const json: Item = { pk: { S: "u1" }, sk: { N: "1" }, config: { S: '{"size":12}' } }
    const edits = stageTreeEdit(EMPTY_DYNAMO_EDITS, {
      item: json,
      schema,
      path: ["config"],
      jsonPath: ["size"],
      text: "13",
    })
    if (!edits.ok) throw new Error(edits.error)
    const refreshed = { ...json, config: { S: '{ "size": 14 }' } }
    const again = stageTreeEdit(edits.value, {
      item: refreshed,
      schema,
      path: ["config"],
      jsonPath: ["size"],
      text: "15",
    })
    expect(again).toEqual({ ok: false, error: "Not compact JSON, so an edit would reformat it" })
  })
})

describe("list element leaves", () => {
  const tags = (...values: string[]) => ({ L: values.map((v) => ({ S: v })) })
  const loaded: Item = { pk: { S: "u1" }, sk: { N: "1" }, tags: tags("y", "x", "x", "w") }

  it("guards the whole list when the edited value is itself an element", () => {
    const staged = stageTreeEdit(EMPTY_DYNAMO_EDITS, {
      item: loaded,
      schema,
      path: ["tags", 1],
      jsonPath: [],
      text: "z",
    })
    if (!staged.ok) throw new Error(staged.error)
    const [update] = buildItemUpdates(staged.value)
    expect(update.changes).toEqual([
      { name: "tags", path: [1], value: { S: "z" }, expected: { S: "x" } },
    ])
    expect(update.expected).toEqual([{ name: "tags", value: tags("y", "x", "x", "w") }])

    // `y` removed: index 1 still holds an `x`, but it is the other one.
    const shifted = { ...loaded, tags: tags("x", "x", "w") }
    const edit = itemEdit(staged.value, loaded, schema)
    expect(conflictingChanges(edit, shifted)).toHaveLength(1)
    expect(withPendingValues(shifted, edit)).toEqual(shifted)
  })
})
