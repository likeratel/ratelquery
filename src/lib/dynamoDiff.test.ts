import { describe, expect, it } from "vitest"
import type { Item, KeySchema } from "./dynamo"
import {
  attributesEqual,
  diffItems,
  itemKey,
  keyChanged,
  putExpectation,
  validateKeyAttributes,
} from "./dynamoDiff"

const schema: KeySchema = { hash: { name: "pk", type: "S" }, range: { name: "sk", type: "N" } }

const original: Item = {
  pk: { S: "u1" },
  sk: { N: "1" },
  name: { S: "Ada" },
  tags: { SS: ["a", "b"] },
  meta: { M: { n: { N: "1.50" } } },
}

describe("attributesEqual", () => {
  it("compares numbers by value and sets without order", () => {
    expect(attributesEqual({ N: "1.50" }, { N: "1.5" })).toBe(true)
    expect(attributesEqual({ SS: ["a", "b"] }, { SS: ["b", "a"] })).toBe(true)
    expect(attributesEqual({ NS: ["1", "2.0"] }, { NS: ["2", "1"] })).toBe(true)
    expect(attributesEqual({ L: [{ S: "a" }, { S: "b" }] }, { L: [{ S: "b" }, { S: "a" }] })).toBe(
      false,
    )
    expect(attributesEqual({ S: "1" }, { N: "1" })).toBe(false)
    expect(attributesEqual({ M: { a: { S: "x" } } }, { M: { a: { S: "x" }, b: { S: "y" } } })).toBe(
      false,
    )
  })

  it("compares numbers that aren't decimals by their text", () => {
    expect(attributesEqual({ N: "abc" }, { N: "xyz" })).toBe(false)
    expect(attributesEqual({ N: "abc" }, { N: "abc" })).toBe(true)
    expect(attributesEqual({ N: "abc" }, { N: "1" })).toBe(false)
  })
})

describe("diffItems", () => {
  it("lists added, changed and removed attributes", () => {
    const edited: Item = {
      pk: { S: "u1" },
      sk: { N: "1" },
      name: { S: "Grace" },
      tags: { SS: ["b", "a"] },
      meta: { M: { n: { N: "1.5" } } },
      email: { S: "g@x" },
    }
    const { name: _dropped, ...withoutName } = edited
    expect(diffItems(original, edited).map((c) => [c.name, c.kind])).toEqual([
      ["name", "changed"],
      ["email", "added"],
    ])
    expect(diffItems(original, withoutName).map((c) => [c.name, c.kind])).toEqual([
      ["name", "removed"],
      ["email", "added"],
    ])
    expect(diffItems(original, original)).toEqual([])
  })

  it("treats every attribute of a new item as added", () => {
    expect(diffItems(null, { pk: { S: "x" } })).toEqual([
      { name: "pk", kind: "added", before: null, after: { S: "x" } },
    ])
  })
})

describe("keys", () => {
  it("extracts the key and detects key changes", () => {
    expect(itemKey(original, schema)).toEqual({ pk: { S: "u1" }, sk: { N: "1" } })
    expect(itemKey({ pk: { S: "u1" } }, schema)).toBeNull()
    expect(keyChanged(original, { ...original, name: { S: "x" } }, schema)).toBe(false)
    expect(keyChanged(original, { ...original, sk: { N: "1.0" } }, schema)).toBe(false)
    expect(keyChanged(original, { ...original, sk: { N: "2" } }, schema)).toBe(true)
  })

  it("picks the safe-write condition", () => {
    expect(putExpectation(original, { ...original, name: { S: "x" } }, schema)).toBe("exists")
    expect(putExpectation(original, { ...original, pk: { S: "u2" } }, schema)).toBe("not_exists")
    expect(putExpectation(null, original, schema)).toBe("not_exists")
  })

  it("validates key presence and type", () => {
    expect(validateKeyAttributes(original, schema)).toBeNull()
    expect(validateKeyAttributes({ pk: { S: "a" } }, schema)).toBe("Missing sort key sk (N)")
    expect(validateKeyAttributes({ pk: { N: "1" }, sk: { N: "1" } }, schema)).toBe(
      "Partition key pk must be S, not N",
    )
  })
})
