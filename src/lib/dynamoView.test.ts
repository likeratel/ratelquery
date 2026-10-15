import { describe, expect, it } from "vitest"
import type { Item, KeySchema } from "./dynamo"
import {
  attributeSummary,
  attributeToCell,
  columnInfos,
  itemCells,
  itemColumns,
} from "./dynamoView"

const schema: KeySchema = { hash: { name: "pk", type: "S" }, range: { name: "sk", type: "N" } }

const items: Item[] = [
  { name: { S: "a" }, sk: { N: "1" }, pk: { S: "u1" } },
  { pk: { S: "u2" }, sk: { N: "2" }, age: { N: "3" }, name: { NULL: true } },
]

describe("itemColumns", () => {
  it("puts key attributes first, then the union in first-seen order", () => {
    const columns = itemColumns(items, schema)
    expect(columns.map((c) => c.name)).toEqual(["pk", "sk", "name", "age"])
    expect(columns[0]).toEqual({ name: "pk", types: ["S"], key: "partition" })
    expect(columns[2]).toEqual({ name: "name", types: ["S", "NULL"], key: null })
  })

  it("keeps key columns when the page is empty and works without a schema", () => {
    expect(itemColumns([], schema).map((c) => c.name)).toEqual(["pk", "sk"])
    expect(itemColumns(items, null).map((c) => c.name)).toEqual(["name", "sk", "pk", "age"])
  })

  it("labels header types with the key role", () => {
    const [pk, , name] = columnInfos(itemColumns(items, schema))
    expect(pk.typeName).toBe("S · partition key")
    expect(name.typeName).toBe("S | NULL")
  })
})

describe("cells", () => {
  it("maps attributes onto grid tones", () => {
    expect(attributeToCell({ S: "x" })).toEqual({ t: "str", v: "x" })
    expect(attributeToCell({ N: "12345678901234567890" })).toEqual({
      t: "decimal",
      v: "12345678901234567890",
    })
    expect(attributeToCell({ BOOL: false })).toEqual({ t: "bool", v: false })
    expect(attributeToCell({ NULL: true })).toEqual({ t: "null" })
    expect(attributeToCell({ M: { a: { N: "1" } } })).toEqual({ t: "json", v: '{"a":1}' })
    expect(attributeToCell({ SS: ["a"] })).toEqual({ t: "json", v: '["a"]' })
  })

  it("leaves missing attributes undefined", () => {
    const columns = itemColumns(items, schema)
    expect(itemCells(items[0], columns).at(-1)).toBeUndefined()
  })

  it("summarises values with set tags kept visible", () => {
    expect(attributeSummary({ S: "a" })).toBe('"a"')
    expect(attributeSummary({ NS: ["1"] })).toBe('NS ["1"]')
    expect(attributeSummary({ L: [{ N: "1" }] })).toBe("[1]")
  })
})
