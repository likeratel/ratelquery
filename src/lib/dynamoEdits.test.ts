import { describe, expect, it } from "vitest"
import type { Item, KeySchema } from "./dynamo"
import {
  buildItemUpdates,
  EMPTY_DYNAMO_EDITS,
  failedEditHint,
  inlineEditType,
  itemEdit,
  keyId,
  keyLabel,
  markFailed,
  parseDynamoNumber,
  parseInlineValue,
  pendingEditCount,
  stageCellEdit,
  withoutItems,
  withPendingValues,
  type DynamoEdits,
} from "./dynamoEdits"

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
    expect(edits[id].changes).toEqual({
      name: { before: { S: "Ada" }, after: { S: "Grace" } },
      age: { before: { N: "36" }, after: { N: "37" } },
    })
    expect(pendingEditCount(edits)).toBe(2)
  })

  it("unstages a value edited back to where it started", () => {
    const edits = stage(stage(EMPTY_DYNAMO_EDITS, "age", "37"), "age", "36.0")
    expect(edits).toEqual(EMPTY_DYNAMO_EDITS)
  })

  it("keeps the first starting value across repeated edits and refreshed items", () => {
    const refreshed = { ...item, name: { S: "Changed elsewhere" } }
    const edits = stage(stage(EMPTY_DYNAMO_EDITS, "name", "Grace"), "name", "Lin", refreshed)
    expect(itemEdit(edits, item, schema)?.changes.name).toEqual({
      before: { S: "Ada" },
      after: { S: "Lin" },
    })
  })

  it("adds a missing attribute as a string, and leaves it missing when left empty", () => {
    expect(stage(EMPTY_DYNAMO_EDITS, "note", "")).toEqual(EMPTY_DYNAMO_EDITS)
    const edits = stage(EMPTY_DYNAMO_EDITS, "note", "hi")
    expect(itemEdit(edits, item, schema)?.changes.note).toEqual({
      before: null,
      after: { S: "hi" },
    })
    expect(stage(edits, "note", "")).toEqual(EMPTY_DYNAMO_EDITS)
  })

  it("stages an emptied string as an empty string", () => {
    const edits = stage(EMPTY_DYNAMO_EDITS, "name", "")
    expect(itemEdit(edits, item, schema)?.changes.name.after).toEqual({ S: "" })
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
