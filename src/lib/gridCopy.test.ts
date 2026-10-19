import { describe, expect, it } from "vitest"
import { copyRowsText, copyText, gridCopyText } from "./gridCopy"

describe("copyText", () => {
  it("copies one cell as its plain text", () => {
    expect(copyText([{ t: "str", v: 'say "hi"\tthere' }])).toBe('say "hi"\tthere')
    expect(copyText([{ t: "null" }])).toBe("NULL")
    expect(copyText([{ t: "bool", v: true }])).toBe("true")
  })

  it("tab-separates a row and quotes fields that would break the columns", () => {
    expect(
      copyText([
        { t: "int", v: "1" },
        { t: "str", v: "a\tb" },
        { t: "str", v: 'x"y' },
        undefined,
        { t: "float", v: 1.5 },
      ]),
    ).toBe('1\t"a\tb"\t"x""y"\t\t1.5')
  })
})

describe("copyRowsText", () => {
  it("puts one row per line and quotes fields", () => {
    expect(
      copyRowsText([
        [
          { t: "int", v: "1" },
          { t: "str", v: "a\nb" },
        ],
        [{ t: "int", v: "2" }, { t: "null" }],
      ]),
    ).toBe('1\t"a\nb"\n2\tNULL')
  })

  it("adds the column names as the first line", () => {
    expect(copyRowsText([[{ t: "int", v: "1" }, undefined]], { header: ["id", 'na"me'] })).toBe(
      'id\t"na""me"\n1\t',
    )
  })

  it("quotes a one-column row like any field", () => {
    expect(copyRowsText([[{ t: "str", v: "a\tb" }]])).toBe('"a\tb"')
  })
})

describe("gridCopyText", () => {
  const source = {
    rows: [
      { cells: [{ t: "int", v: "1" } as const, { t: "str", v: "x" } as const] },
      { cells: [{ t: "int", v: "2" } as const, { t: "str", v: "y" } as const] },
    ],
    columnNames: ["id", "name"],
    targetRows: [1, 0],
    cell: { row: 1, col: 1 },
  }

  it("copies the target rows in the given order, with names when asked", () => {
    expect(gridCopyText("rows", source)).toBe("2\ty\n1\tx")
    expect(gridCopyText("rows-with-names", { ...source, targetRows: [0] })).toBe("id\tname\n1\tx")
  })

  it("copies one cell as plain text", () => {
    expect(gridCopyText("cell", source)).toBe("y")
  })

  it("returns null when there is nothing to copy", () => {
    expect(gridCopyText("rows", { ...source, targetRows: [] })).toBeNull()
    expect(gridCopyText("rows", { ...source, targetRows: [5] })).toBeNull()
    expect(gridCopyText("cell", { ...source, cell: null })).toBeNull()
  })
})
