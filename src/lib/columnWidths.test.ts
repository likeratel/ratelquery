import { describe, expect, it } from "vitest"
import { columnSignature, WidthMemory } from "./columnWidths"

describe("WidthMemory", () => {
  it("restores widths for the same grid and column names only", () => {
    const memory = new WidthMemory()
    memory.remember("t1:0", ["id", "email"], [80, 240])
    expect(memory.recall("t1:0", ["id", "email"])).toEqual([80, 240])
    expect(memory.recall("t1:0", ["id", "name"])).toBeUndefined()
    expect(memory.recall("t1:0", ["email", "id"])).toBeUndefined()
    expect(memory.recall("t2:0", ["id", "email"])).toBeUndefined()
  })

  it("stores a copy and evicts the least recently resized grid", () => {
    const memory = new WidthMemory(2)
    const widths = [10]
    memory.remember("a", ["x"], widths)
    widths[0] = 99
    memory.remember("b", ["x"], [20])
    memory.remember("a", ["x"], [11])
    memory.remember("c", ["x"], [30])
    expect(memory.size).toBe(2)
    expect(memory.recall("b", ["x"])).toBeUndefined()
    expect(memory.recall("a", ["x"])).toEqual([11])
  })

  it("keeps names with separators apart", () => {
    expect(columnSignature(["a,b"])).not.toBe(columnSignature(["a", "b"]))
  })
})
