import { describe, expect, it } from "vitest"
import { pathKey } from "./dynamoPath"
import type { Item } from "./dynamo"
import {
  canonicalDecimal,
  findLossyAttributes,
  formatItem,
  inexactNumberLiterals,
  isExactNumber,
  itemToPlain,
  jsonInString,
  jsonNumberSources,
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
    expect(jsonInString('{"a":1}')).toEqual({
      value: { a: 1 },
      exact: true,
      compact: true,
      numbers: new Map(),
    })
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

  it("keeps numbers written another way as they are stored", () => {
    const json = jsonInString('{"big":1000000000000000000000,"price":1.50,"n":2}')
    expect(json).toMatchObject({ exact: true, compact: false })
    expect(json?.numbers).toEqual(
      new Map([
        [pathKey(["big"]), "1000000000000000000000"],
        [pathKey(["price"]), "1.50"],
      ]),
    )
    expect(jsonInString('{"n":1}')?.numbers.size).toBe(0)
  })

  it("stays read-only rather than failing on JSON nested too deep to stringify", () => {
    const depth = 200_000
    const json = jsonInString("[".repeat(depth) + "]".repeat(depth))
    expect(json).toMatchObject({ exact: true, compact: false })
  })
})

describe("jsonNumberSources", () => {
  it("maps each number literal written another way to its path", () => {
    const text = '{"a":[1.0, 2, {"b": -0.50e1, "s": "1.0 \\" 2e3"}], "c": 1e3, "d": 100, "e": true}'
    expect(jsonNumberSources(text)).toEqual(
      new Map([
        [pathKey(["a", 0]), "1.0"],
        [pathKey(["a", 2, "b"]), "-0.50e1"],
        [pathKey(["c"]), "1e3"],
      ]),
    )
  })

  it("follows JSON.parse: a repeated key keeps its last value, digit keys stay keys", () => {
    expect(jsonNumberSources('{"a":1.0,"a":2.0,"1":3.0}')).toEqual(
      new Map([
        [pathKey(["a"]), "2.0"],
        [pathKey(["1"]), "3.0"],
      ]),
    )
  })

  it("drops what an earlier value of a repeated key recorded, at the key and below it", () => {
    expect(jsonNumberSources('{"a": 1.50, "a": 2}')).toEqual(new Map())
    expect(jsonNumberSources('{"a":[1.50],"a":[2]}')).toEqual(new Map())
    expect(jsonNumberSources('{"a":{"b":1.50,"c":[1e3]},"a":{"b":2}}')).toEqual(new Map())
    // Keys that only start alike, and the same key in another object, stay.
    expect(
      jsonNumberSources('{"ab":1.50,"a":{"x":1.0},"o":{"a":1e3},"a":2,"o2":{"a":1e2}}'),
    ).toEqual(
      new Map([
        [pathKey(["ab"]), "1.50"],
        [pathKey(["o", "a"]), "1e3"],
        [pathKey(["o2", "a"]), "1e2"],
      ]),
    )
    // The tree then shows the value JSON.parse kept.
    expect(jsonInString('{"a": 1.50, "a": 2}')?.numbers.size).toBe(0)
  })

  it("takes time linear in the text, with numbers recorded and no key repeated", () => {
    // Not compact (1.50, 0.80), so every record adds two numbers before more keys follow.
    const records = (n: number) =>
      JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: "x" }))).replace(
        /"name"/g,
        '"price":10.50,"tax":0.80,"name"',
      )
    const fastest = (text: string) => {
      let best = Infinity
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now()
        jsonNumberSources(text)
        best = Math.min(best, performance.now() - start)
      }
      return best
    }
    const small = records(2_000)
    const large = records(20_000)
    expect(jsonNumberSources(large).size).toBe(40_000)
    fastest(small)
    // Ten times the text: linear is about 10x, the quadratic scan it replaces was about 100x.
    expect(fastest(large)).toBeLessThan(Math.max(fastest(small), 0.5) * 40)
  })

  it("skips paths deeper than the limit, without recursion", () => {
    expect(jsonNumberSources("[[1.0],2.0]", 1)).toEqual(new Map([[pathKey([1]), "2.0"]]))
    const depth = 100_000
    const deep = "[".repeat(depth) + "1.0" + "]".repeat(depth)
    expect(jsonNumberSources(deep).size).toBe(0)
  })
})
