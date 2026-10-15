import { describe, expect, it } from "vitest"
import { tokenizeJson } from "./jsonTokens"

describe("tokenizeJson", () => {
  it("separates keys from string values and keeps every character", () => {
    const text = JSON.stringify({ a: "x:1", n: -1.5, b: true, z: null, l: ["s"] }, null, 2)
    const tokens = tokenizeJson(text)
    expect(tokens.map((t) => t.text).join("")).toBe(text)
    expect(tokens.filter((t) => t.kind !== "punct").map((t) => [t.kind, t.text])).toEqual([
      ["key", '"a"'],
      ["string", '"x:1"'],
      ["key", '"n"'],
      ["number", "-1.5"],
      ["key", '"b"'],
      ["bool", "true"],
      ["key", '"z"'],
      ["null", "null"],
      ["key", '"l"'],
      ["string", '"s"'],
    ])
  })
})
