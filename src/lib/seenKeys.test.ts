import { describe, expect, it } from "vitest"
import { SeenKeys } from "./seenKeys"

describe("SeenKeys", () => {
  it("forgets keys by prefix and keeps the rest", () => {
    const seen = new SeenKeys()
    seen.add("t1:1")
    seen.add("t1:2")
    seen.add("t12:1")
    seen.forgetPrefix("t1:")
    expect(seen.has("t1:1")).toBe(false)
    expect(seen.has("t12:1")).toBe(true)
    expect(seen.size).toBe(1)
  })
})
