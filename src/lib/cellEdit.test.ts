import { describe, expect, it } from "vitest"
import { cellKindForType, cellToEditText, cellsEqual, parseCellInput } from "./cellEdit"

const col = (typeName: string, nullable = true) => ({ name: "c", typeName, nullable })

describe("cellKindForType", () => {
  it("maps result and schema type names", () => {
    expect(cellKindForType("BIGINT")).toBe("int")
    expect(cellKindForType("int unsigned")).toBe("int")
    expect(cellKindForType("tinyint(1)")).toBe("bool")
    expect(cellKindForType("TINYINT")).toBe("int")
    expect(cellKindForType("DECIMAL")).toBe("decimal")
    expect(cellKindForType("DOUBLE")).toBe("float")
    expect(cellKindForType("TIMESTAMP")).toBe("datetime")
    expect(cellKindForType("JSON")).toBe("json")
    expect(cellKindForType("VARBINARY")).toBe("bytes")
    expect(cellKindForType("varchar(255)")).toBe("str")
    expect(cellKindForType("ENUM")).toBe("str")
  })
})

describe("parseCellInput", () => {
  it("turns the NULL literal into null only for nullable columns", () => {
    expect(parseCellInput("NULL", col("INT"))).toEqual({ ok: true, cell: { t: "null" } })
    expect(parseCellInput("NULL", col("INT", false))).toEqual({
      ok: false,
      error: "c can't be NULL",
    })
    expect(parseCellInput("null", col("VARCHAR"))).toEqual({
      ok: true,
      cell: { t: "str", v: "null" },
    })
  })

  it("keeps integers as decimal strings without losing precision", () => {
    expect(parseCellInput(" 9007199254740993 ", col("BIGINT"))).toEqual({
      ok: true,
      cell: { t: "int", v: "9007199254740993" },
    })
    expect(parseCellInput("+007", col("INT"))).toEqual({ ok: true, cell: { t: "int", v: "7" } })
    expect(parseCellInput("1.5", col("INT")).ok).toBe(false)
    expect(parseCellInput("-1", col("int unsigned")).ok).toBe(false)
  })

  it("parses floats, decimals and booleans", () => {
    expect(parseCellInput("1e3", col("DOUBLE"))).toEqual({
      ok: true,
      cell: { t: "float", v: 1000 },
    })
    expect(parseCellInput("12.50", col("DECIMAL"))).toEqual({
      ok: true,
      cell: { t: "decimal", v: "12.50" },
    })
    expect(parseCellInput("abc", col("DECIMAL")).ok).toBe(false)
    expect(parseCellInput("TRUE", col("tinyint(1)"))).toEqual({
      ok: true,
      cell: { t: "bool", v: true },
    })
    expect(parseCellInput("0", col("BIT"))).toEqual({ ok: true, cell: { t: "bool", v: false } })
  })

  it("accepts only decimal notation for floats", () => {
    expect(parseCellInput("-.5", col("DOUBLE"))).toEqual({
      ok: true,
      cell: { t: "float", v: -0.5 },
    })
    expect(parseCellInput("2.5E-3", col("FLOAT"))).toEqual({
      ok: true,
      cell: { t: "float", v: 0.0025 },
    })
    for (const text of ["0x10", "0b1", "0o7", "Infinity", "1e400", "1_000", "e5"]) {
      expect(parseCellInput(text, col("DOUBLE"))).toEqual({ ok: false, error: "Enter a number" })
    }
  })

  it("validates temporal formats and normalizes datetimes", () => {
    expect(parseCellInput("2024-02-03", col("DATE"))).toEqual({
      ok: true,
      cell: { t: "date", v: "2024-02-03" },
    })
    expect(parseCellInput("2024-02-03T04:05:06.5", col("DATETIME"))).toEqual({
      ok: true,
      cell: { t: "datetime", v: "2024-02-03 04:05:06.5" },
    })
    expect(parseCellInput("2024-02-03", col("DATETIME"))).toEqual({
      ok: true,
      cell: { t: "datetime", v: "2024-02-03 00:00:00" },
    })
    expect(parseCellInput("12:30:00", col("TIME")).ok).toBe(true)
    expect(parseCellInput("03/02/2024", col("DATE")).ok).toBe(false)
  })

  it("validates JSON and refuses binary text", () => {
    expect(parseCellInput('{"a":1}', col("JSON"))).toEqual({
      ok: true,
      cell: { t: "json", v: '{"a":1}' },
    })
    expect(parseCellInput("{a:1}", col("JSON")).ok).toBe(false)
    expect(parseCellInput("abc", col("BLOB")).ok).toBe(false)
  })

  it("prefers the original cell tag over the type name", () => {
    expect(parseCellInput("1", col("TINYINT"), { t: "bool", v: false })).toEqual({
      ok: true,
      cell: { t: "bool", v: true },
    })
  })

  it("keeps strings verbatim, including whitespace and empty text", () => {
    expect(parseCellInput("  hi ", col("VARCHAR"))).toEqual({
      ok: true,
      cell: { t: "str", v: "  hi " },
    })
    expect(parseCellInput("", col("VARCHAR"))).toEqual({ ok: true, cell: { t: "str", v: "" } })
    expect(parseCellInput("", col("INT")).ok).toBe(false)
  })
})

describe("cellToEditText and cellsEqual", () => {
  it("round-trips through the editor text", () => {
    expect(cellToEditText({ t: "null" })).toBe("NULL")
    expect(cellToEditText({ t: "bool", v: true })).toBe("true")
    expect(cellToEditText({ t: "float", v: 1.25 })).toBe("1.25")
    expect(cellToEditText({ t: "int", v: "42" })).toBe("42")
  })

  it("compares tag and value", () => {
    expect(cellsEqual({ t: "null" }, { t: "null" })).toBe(true)
    expect(cellsEqual({ t: "int", v: "1" }, { t: "int", v: "1" })).toBe(true)
    expect(cellsEqual({ t: "int", v: "1" }, { t: "str", v: "1" })).toBe(false)
    expect(cellsEqual({ t: "null" }, { t: "str", v: "" })).toBe(false)
  })
})
