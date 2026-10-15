import { describe, expect, it } from "vitest"
import {
  base64ByteLength,
  cellTone,
  formatBytes,
  formatCell,
  initialColumnWidth,
} from "./cellFormat"

describe("formatCell", () => {
  it("renders every tag as a single line", () => {
    expect(formatCell({ t: "null" })).toBe("NULL")
    expect(formatCell({ t: "bool", v: false })).toBe("false")
    expect(formatCell({ t: "str", v: "a\nb" })).toBe("a b")
    expect(formatCell({ t: "bytes", v: "AAEC" })).toBe("(binary, 3 bytes)")
  })

  it("maps tags to data tones", () => {
    expect(cellTone({ t: "decimal", v: "1" })).toBe("number")
    expect(cellTone({ t: "datetime", v: "x" })).toBe("date")
    expect(cellTone({ t: "null" })).toBe("null")
  })
})

describe("helpers", () => {
  it("computes base64 byte lengths", () => {
    expect(base64ByteLength("")).toBe(0)
    expect(base64ByteLength("AA==")).toBe(1)
    expect(base64ByteLength("AAA=")).toBe(2)
  })

  it("clamps initial column widths", () => {
    const column = { name: "id", typeName: "INT", table: "t", nullable: false }
    expect(initialColumnWidth(column, [[{ t: "int", v: "1" }]], 0)).toBe(64)
    const wide = [[{ t: "str" as const, v: "x".repeat(500) }]]
    expect(initialColumnWidth(column, wide, 0)).toBe(360)
  })

  it("formats byte counts", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
  })
})
