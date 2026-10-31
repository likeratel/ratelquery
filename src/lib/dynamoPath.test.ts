import { describe, expect, it } from "vitest"
import type { Item } from "./dynamo"
import {
  attributeAt,
  formatPath,
  isPathPrefix,
  jsonAt,
  parsePath,
  pathKey,
  releasedPath,
  withAttributeAt,
  withJsonAt,
} from "./dynamoPath"

const item: Item = {
  service: { M: { numbers: { L: [{ M: { sender: { S: "010" } } }, { S: "x" }] } } },
  name: { S: "Ada" },
}

describe("pathKey / formatPath / isPathPrefix", () => {
  it("keeps list indexes and numeric map keys apart", () => {
    expect(pathKey(["a", 0])).not.toBe(pathKey(["a", "0"]))
  })

  it("formats document paths and quotes odd keys", () => {
    expect(formatPath(["senderService", "numbers", 0, "senderNumber"])).toBe(
      "senderService.numbers[0].senderNumber",
    )
    expect(formatPath(["a-b", "c d", "7", 2])).toBe('["a-b"]["c d"]["7"][2]')
    expect(formatPath(["a.b"])).not.toBe(formatPath(["a", "b"]))
  })

  it("treats a path as its own prefix", () => {
    expect(isPathPrefix(["a"], ["a", 1])).toBe(true)
    expect(isPathPrefix(["a", 1], ["a", 1])).toBe(true)
    expect(isPathPrefix(["a", 1], ["a"])).toBe(false)
    expect(isPathPrefix(["a", "1"], ["a", 1])).toBe(false)
  })
})

describe("releasedPath", () => {
  it("clears the path only when the leaf letting go still holds it", () => {
    const a = ["n", 0] as const
    const b = ["n", 1] as const
    expect(releasedPath(a, ["n", 0])).toBeNull()
    expect(releasedPath(b, a)).toBe(b)
    expect(releasedPath(null, a)).toBeNull()
    expect(releasedPath(["n", "0"], a)).toEqual(["n", "0"])
  })
})

describe("parsePath", () => {
  it("reads back every path formatPath writes", () => {
    const paths = [
      ["senderService", "numbers", 0, "senderNumber"],
      ["a-b", "c d", "7", 2],
      ["a.b"],
      ['say "hi"', 10],
      ["$x", "_y"],
    ]
    for (const path of paths) expect(parsePath(formatPath(path))).toEqual(path)
  })

  it("rejects text that isn't a path", () => {
    for (const text of [
      "",
      ".a",
      "a.",
      "a..b",
      "a[x]",
      "a[",
      "1.5",
      "a b",
      "a[0]b",
      String.raw`["\q"]`,
    ]) {
      expect(parsePath(text)).toBeNull()
    }
  })
})

describe("attributeAt / withAttributeAt", () => {
  it("walks maps by key and lists by index", () => {
    expect(attributeAt(item, ["service", "numbers", 0, "sender"])).toEqual({ S: "010" })
    expect(attributeAt(item, ["service", "numbers", "0"])).toBeUndefined()
    expect(attributeAt(item, ["service", "numbers", 3])).toBeUndefined()
    expect(attributeAt(item, ["name", "x"])).toBeUndefined()
    expect(attributeAt(item, ["toString"])).toBeUndefined()
  })

  it("replaces a nested value without touching the original", () => {
    const next = withAttributeAt(item, ["service", "numbers", 0, "sender"], { S: "011" })
    expect(attributeAt(next ?? {}, ["service", "numbers", 0, "sender"])).toEqual({ S: "011" })
    expect(attributeAt(next ?? {}, ["service", "numbers", 1])).toEqual({ S: "x" })
    expect(attributeAt(item, ["service", "numbers", 0, "sender"])).toEqual({ S: "010" })
    expect(withAttributeAt(item, ["name"], { S: "B" })?.name).toEqual({ S: "B" })
  })

  it("returns null when the path leads nowhere", () => {
    expect(withAttributeAt(item, ["service", "numbers", 9], { S: "y" })).toBeNull()
    expect(withAttributeAt(item, ["missing"], { S: "y" })).toBeNull()
  })
})

describe("jsonAt / withJsonAt", () => {
  const value = { a: [1, { b: true }], "0": "zero" }

  it("reads and replaces values inside parsed JSON", () => {
    expect(jsonAt(value, ["a", 1, "b"])).toBe(true)
    expect(jsonAt(value, ["0"])).toBe("zero")
    expect(jsonAt(value, ["a", "1"])).toBeUndefined()
    expect(withJsonAt(value, ["a", 1, "b"], false)).toEqual({ a: [1, { b: false }], "0": "zero" })
    expect(value.a[1]).toEqual({ b: true })
    expect(withJsonAt(value, ["a", 5], 1)).toBeNull()
    expect(withJsonAt(value, [], 3)).toBe(3)
  })
})
