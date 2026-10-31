import { describe, expect, it } from "vitest"
import type { Item } from "./dynamo"
import {
  canonicalDecimal,
  findLossyAttributes,
  formatItem,
  inexactNumberLiterals,
  isExactNumber,
  itemToPlain,
  jsonInString,
  jsonStringReadOnlyReason,
  parsePlainItem,
  parseWireItem,
  plainToItem,
  plainToWire,
  validateAttribute,
  wireToPlain,
} from "./dynamoJson"

const plainSafe: Item = {
  pk: { S: "user#1" },
  age: { N: "42" },
  ratio: { N: "0.25" },
  active: { BOOL: true },
  nothing: { NULL: true },
  profile: { M: { name: { S: "Ada" }, tags: { L: [{ S: "a" }, { N: "1" }] } } },
}

describe("canonicalDecimal", () => {
  it("normalises equivalent spellings", () => {
    expect(canonicalDecimal("1.50")).toBe(canonicalDecimal("15e-1"))
    expect(canonicalDecimal("0100")).toBe("1e2")
    expect(canonicalDecimal("-0.0")).toBe("0")
    expect(canonicalDecimal("abc")).toBeNull()
    expect(canonicalDecimal(".")).toBeNull()
  })

  it("flags numbers beyond double precision", () => {
    expect(isExactNumber("9007199254740991")).toBe(true)
    expect(isExactNumber("9007199254740993")).toBe(false)
    expect(isExactNumber("0.1")).toBe(true)
    expect(isExactNumber("3.14159265358979323846")).toBe(false)
    expect(isExactNumber("1e400")).toBe(false)
  })
})

describe("wireToPlain", () => {
  it("converts scalars and nested values", () => {
    expect(itemToPlain(plainSafe)).toEqual({
      pk: "user#1",
      age: 42,
      ratio: 0.25,
      active: true,
      nothing: null,
      profile: { name: "Ada", tags: ["a", 1] },
    })
  })

  it("keeps inexact numbers as strings and sets as arrays", () => {
    expect(wireToPlain({ N: "12345678901234567890" })).toBe("12345678901234567890")
    expect(wireToPlain({ SS: ["a", "b"] })).toEqual(["a", "b"])
    expect(wireToPlain({ NS: ["1", "2.5"] })).toEqual([1, 2.5])
    expect(wireToPlain({ B: "AAE=" })).toBe("AAE=")
  })
})

describe("plainToWire", () => {
  it("infers types from plain JSON", () => {
    expect(plainToWire(null)).toEqual({ NULL: true })
    expect(plainToWire(3)).toEqual({ N: "3" })
    expect(plainToWire("x")).toEqual({ S: "x" })
    expect(plainToWire(false)).toEqual({ BOOL: false })
    expect(plainToWire([1, { a: "b" }])).toEqual({ L: [{ N: "1" }, { M: { a: { S: "b" } } }] })
  })

  it("round-trips items without lossy types", () => {
    expect(plainToItem(itemToPlain(plainSafe))).toEqual(plainSafe)
    expect(parsePlainItem(formatItem(plainSafe, "plain"))).toEqual({ ok: true, value: plainSafe })
    expect(parseWireItem(formatItem(plainSafe, "wire"))).toEqual({ ok: true, value: plainSafe })
  })
})

describe("findLossyAttributes", () => {
  it("is empty for plain-safe items", () => {
    expect(findLossyAttributes(plainSafe)).toEqual([])
  })

  it("reports sets, binary and precise numbers with their paths", () => {
    const item: Item = {
      tags: { SS: ["a"] },
      scores: { NS: ["1"] },
      blobs: { BS: ["AA=="] },
      raw: { B: "AA==" },
      big: { N: "12345678901234567890" },
      nested: { M: { list: { L: [{ S: "ok" }, { SS: ["x"] }] } } },
    }
    expect(findLossyAttributes(item).map((l) => `${l.path}:${l.type}`)).toEqual([
      "tags:SS",
      "scores:NS",
      "blobs:BS",
      "raw:B",
      "big:N",
      "nested.list[1]:SS",
    ])
  })
})

describe("parsing", () => {
  it("validates wire attributes", () => {
    expect(validateAttribute({ N: 5 }, "n")).toMatch(/N must be a number in a string/)
    expect(validateAttribute({ S: "a", N: "1" }, "x")).toMatch(/exactly one type key/)
    expect(validateAttribute({ SS: [] }, "s")).toMatch(/at least one value/)
    expect(validateAttribute({ SS: ["a", "a"] }, "s")).toMatch(/duplicates/)
    expect(validateAttribute({ NS: ["1", "1.0"] }, "s")).toMatch(/duplicates/)
    expect(validateAttribute({ B: "not base64!" }, "b")).toMatch(/base64/)
    expect(validateAttribute({ M: { a: { X: 1 } } }, "m")).toMatch(/^m\.a:/)
    expect(validateAttribute({ L: [{ S: "a" }, { BOOL: "yes" }] }, "l")).toMatch(/^l\[1\]:/)
  })

  it("rejects non-objects and invalid JSON", () => {
    expect(parseWireItem("[1]")).toEqual({ ok: false, error: "An item must be a JSON object" })
    expect(parsePlainItem("{")).toMatchObject({ ok: false })
    expect(parseWireItem('{"a": {"S": 1}}')).toEqual({ ok: false, error: "a: S must be a string" })
  })

  it("refuses plain numbers that JSON.parse would round", () => {
    expect(inexactNumberLiterals('{"a": 12345678901234567890, "b": "999999999999999999"}')).toEqual(
      ["12345678901234567890"],
    )
    expect(parsePlainItem('{"a": 12345678901234567890}')).toMatchObject({
      ok: false,
      error: expect.stringContaining("wire mode"),
    })
  })
})

describe("jsonInString", () => {
  it("finds objects and arrays only", () => {
    expect(jsonInString('{"a":1}')).toEqual({ value: { a: 1 }, exact: true, compact: true })
    expect(jsonInString("[1,2]")?.compact).toBe(true)
    for (const text of ["", "plain", "12", '"s"', "{broken", "true"]) {
      expect(jsonInString(text)).toBeNull()
    }
  })

  it("allows edits only when re-stringifying gives the same text", () => {
    for (const text of [
      ' {"a":1}',
      '{ "a": 1 }',
      '{"a":1.0}',
      '{"b":1,"2":2}',
      '{"e":"\\u00e9"}',
    ]) {
      const json = jsonInString(text)
      expect(json?.compact).toBe(false)
      expect(json && jsonStringReadOnlyReason(json)).toMatch(/Not compact JSON/)
    }
  })

  it("flags numbers a JS number would change", () => {
    const json = jsonInString('{"id":12345678901234567890}')
    expect(json).toMatchObject({ exact: false, compact: false })
    expect(json && jsonStringReadOnlyReason(json)).toMatch(/beyond 2\^53/)
    const exact = jsonInString('{"n":9007199254740991}')
    expect(exact && jsonStringReadOnlyReason(exact)).toBeNull()
  })
})
