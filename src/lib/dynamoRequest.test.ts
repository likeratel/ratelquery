import { describe, expect, it } from "vitest"
import type { TableDescription } from "./dynamo"
import {
  buildDynamoRequest,
  EMPTY_FORM,
  keyValueToWire,
  parseLimit,
  parseNames,
  parseValues,
  withStartKey,
  type DynamoForm,
} from "./dynamoRequest"

const description: TableDescription = {
  name: "orders",
  status: "ACTIVE",
  keySchema: { hash: { name: "pk", type: "S" }, range: { name: "sk", type: "N" } },
  indexes: [
    {
      name: "by_blob",
      kind: "gsi",
      keySchema: { hash: { name: "bin", type: "B" }, range: { name: "title", type: "S" } },
      projection: "all",
    },
    {
      name: "by_status",
      kind: "gsi",
      keySchema: { hash: { name: "status", type: "S" }, range: null },
      projection: "keys_only",
    },
  ],
  itemCount: 10,
  sizeBytes: 100,
  billingMode: "PAY_PER_REQUEST",
}

const form = (patch: Partial<DynamoForm>): DynamoForm => ({ ...EMPTY_FORM, ...patch })
const query = (patch: Partial<DynamoForm>) =>
  buildDynamoRequest({ table: "orders", mode: "query", form: form(patch), description })

describe("key values", () => {
  it("converts by key type", () => {
    expect(keyValueToWire(" a ", "S", "pk")).toEqual({ ok: true, value: { S: " a " } })
    expect(keyValueToWire(" 12.5 ", "N", "sk")).toEqual({ ok: true, value: { N: "12.5" } })
    expect(keyValueToWire("AAE=", "B", "bin")).toEqual({ ok: true, value: { B: "AAE=" } })
    expect(keyValueToWire("abc", "N", "sk")).toMatchObject({ ok: false })
    expect(keyValueToWire("@@", "B", "bin")).toMatchObject({ ok: false })
    expect(keyValueToWire("", "S", "pk")).toEqual({ ok: false, error: "Enter a value for pk" })
  })
})

describe("names and values", () => {
  it("parses one placeholder per line", () => {
    expect(parseNames("#s = status\n\n #n=name ")).toEqual({
      ok: true,
      value: { "#s": "status", "#n": "name" },
    })
    expect(parseNames("s = status")).toMatchObject({ ok: false, error: /start with #/ })
    expect(parseNames("#s = a\n#s = b")).toMatchObject({ ok: false, error: /twice/ })
  })

  it("parses plain JSON values and keeps exact numeric literals", () => {
    expect(parseValues(':s = "open"\n:n = 12345678901234567890\n:b = true\n:l = [1]')).toEqual({
      ok: true,
      value: {
        ":s": { S: "open" },
        ":n": { N: "12345678901234567890" },
        ":b": { BOOL: true },
        ":l": { L: [{ N: "1" }] },
      },
    })
    expect(parseValues(":s = open")).toMatchObject({ ok: false, error: /isn't valid JSON/ })
  })

  it("bounds the limit", () => {
    expect(parseLimit("")).toEqual({ ok: true, value: 100 })
    expect(parseLimit("1000")).toEqual({ ok: true, value: 1000 })
    expect(parseLimit("1001")).toMatchObject({ ok: false })
    expect(parseLimit("2.5")).toMatchObject({ ok: false })
  })
})

describe("buildDynamoRequest", () => {
  it("builds a scan with optional parts only when set", () => {
    expect(
      buildDynamoRequest({ table: "orders", mode: "scan", form: EMPTY_FORM, description: null }),
    ).toEqual({ ok: true, value: { scan: { table: "orders", limit: 100 } } })
    const filtered = buildDynamoRequest({
      table: "orders",
      mode: "scan",
      form: form({ filter: " #s = :s ", names: "#s = status", values: ':s = "open"', limit: "5" }),
      description: null,
    })
    expect(filtered).toEqual({
      ok: true,
      value: {
        scan: {
          table: "orders",
          filter: "#s = :s",
          names: { "#s": "status" },
          values: { ":s": { S: "open" } },
          limit: 5,
        },
      },
    })
  })

  it("converts hash and range values with the table key types", () => {
    expect(query({ hash: "user#1", rangeOp: "ge", rangeValue: "10" })).toEqual({
      ok: true,
      value: {
        query: {
          table: "orders",
          hash: { S: "user#1" },
          range: { op: "ge", value: { N: "10" } },
          limit: 100,
        },
      },
    })
  })

  it("builds between with both bounds and descending order", () => {
    const built = query({
      hash: "u",
      rangeOp: "between",
      rangeValue: "1",
      rangeTo: "9",
      scanForward: false,
    })
    expect(built).toMatchObject({
      ok: true,
      value: {
        query: { range: { op: "between", from: { N: "1" }, to: { N: "9" } }, scanForward: false },
      },
    })
    expect(query({ hash: "u", rangeOp: "between", rangeValue: "1" })).toMatchObject({
      ok: false,
      error: /upper bound/,
    })
  })

  it("uses the index key schema and checks begins_with", () => {
    expect(
      query({ index: "by_blob", hash: "AAE=", rangeOp: "begins_with", rangeValue: "Th" }),
    ).toEqual({
      ok: true,
      value: {
        query: {
          table: "orders",
          index: "by_blob",
          hash: { B: "AAE=" },
          range: { op: "begins_with", value: { S: "Th" } },
          limit: 100,
        },
      },
    })
    expect(query({ hash: "u", rangeOp: "begins_with", rangeValue: "1" })).toMatchObject({
      ok: false,
      error: /string or binary/,
    })
    expect(query({ index: "by_status", hash: "open", rangeOp: "eq" })).toMatchObject({
      ok: false,
      error: /no sort key/,
    })
    expect(query({ index: "missing", hash: "x" })).toMatchObject({ ok: false })
  })

  it("needs the description and a hash value for queries", () => {
    expect(
      buildDynamoRequest({ table: "t", mode: "query", form: EMPTY_FORM, description: null }),
    ).toMatchObject({ ok: false, error: /still loading/ })
    expect(query({})).toMatchObject({ ok: false, error: /partition key pk/ })
  })

  it("adds the start key without touching the original request", () => {
    const base = { scan: { table: "t", limit: 10 } }
    expect(withStartKey(base, { pk: { S: "a" } })).toEqual({
      scan: { table: "t", limit: 10, startKey: { pk: { S: "a" } } },
    })
    expect(withStartKey(base, null)).toEqual(base)
    expect(base).toEqual({ scan: { table: "t", limit: 10 } })
  })
})
