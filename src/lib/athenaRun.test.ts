import { describe, expect, it } from "vitest"
import { athenaStatements, executedStatement, formatDataSize } from "./athenaRun"

describe("athenaStatements", () => {
  it("splits a script into trimmed statements without their semicolons", () => {
    expect(athenaStatements("SELECT 1;\n\n  SELECT 2 ;\nSHOW TABLES")).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SHOW TABLES",
    ])
  })

  it("keeps semicolons inside strings, quoted identifiers and comments", () => {
    const sql = `SELECT 'a;b', "c;d" FROM t -- x; y\n; SELECT 2 /* ; */`
    // A comment after the last code character is not part of the statement, one before its
    // `;` is.
    expect(athenaStatements(sql)).toEqual([`SELECT 'a;b', "c;d" FROM t -- x; y`, "SELECT 2"])
  })

  it("drops empty statements and comment-only text", () => {
    expect(athenaStatements(" ;; -- nothing\n")).toEqual([])
    expect(athenaStatements("")).toEqual([])
  })
})

describe("executedStatement", () => {
  it("strips one trailing semicolon and surrounding whitespace", () => {
    expect(executedStatement("  SELECT 1 ;  ")).toBe("SELECT 1")
    expect(executedStatement("SELECT 1")).toBe("SELECT 1")
  })
})

describe("formatDataSize", () => {
  it("uses the largest binary unit below 1024", () => {
    expect(formatDataSize(0)).toBe("0 B")
    expect(formatDataSize(512)).toBe("512 B")
    expect(formatDataSize(1536)).toBe("1.5 KB")
    expect(formatDataSize(10 * 1024 ** 2)).toBe("10.0 MB")
    expect(formatDataSize(1.25 * 1024 ** 3)).toBe("1.3 GB")
    expect(formatDataSize(2 * 1024 ** 4)).toBe("2.0 TB")
  })

  it("treats negative or invalid sizes as zero", () => {
    expect(formatDataSize(-5)).toBe("0 B")
    expect(formatDataSize(Number.NaN)).toBe("0 B")
  })
})

describe("athenaStatements quoting", () => {
  it("reads double quotes as identifiers, where a backslash doesn't escape", () => {
    expect(athenaStatements('SELECT "dir\\" FROM t; SELECT 2')).toEqual([
      'SELECT "dir\\" FROM t',
      "SELECT 2",
    ])
    expect(athenaStatements('SELECT "a"";b" FROM t; SELECT 2')).toEqual([
      'SELECT "a"";b" FROM t',
      "SELECT 2",
    ])
  })
})
