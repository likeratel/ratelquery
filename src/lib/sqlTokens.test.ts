import { describe, expect, it } from "vitest"
import { ANSI_SYNTAX } from "./sqlContext"
import { tokenizeSql } from "./sqlTokens"

const kinds = (sql: string) => tokenizeSql(sql).map((t) => [t.kind, t.value])

describe("tokenizeSql", () => {
  it("splits words, punctuation, operators and numbers with offsets", () => {
    expect(kinds("select a.b, 1.5 from t where x>=2")).toEqual([
      ["word", "select"],
      ["word", "a"],
      ["punct", "."],
      ["word", "b"],
      ["punct", ","],
      ["number", "1.5"],
      ["word", "from"],
      ["word", "t"],
      ["word", "where"],
      ["word", "x"],
      ["operator", ">"],
      ["operator", "="],
      ["number", "2"],
    ])
    expect(tokenizeSql("  ab")[0]).toMatchObject({ from: 2, to: 4 })
  })

  it("reads backtick identifiers with doubled backticks and reports unclosed ones", () => {
    expect(tokenizeSql("`a``b` `open")).toEqual([
      { kind: "quoted", from: 0, to: 6, value: "a`b", closed: true },
      { kind: "quoted", from: 7, to: 12, value: "open", closed: false },
    ])
  })

  it("keeps strings and comments whole", () => {
    expect(kinds("'it''s' \"a\\\"b\" -- c\n# d\n/* e */ f")).toEqual([
      ["string", "'it''s'"],
      ["string", '"a\\"b"'],
      ["comment", "-- c"],
      ["comment", "# d"],
      ["comment", "/* e */"],
      ["word", "f"],
    ])
    expect(tokenizeSql("/* open")[0]?.closed).toBe(false)
    expect(tokenizeSql("-- line")[0]?.closed).toBe(false)
  })

  it("treats the body of an executable comment as code", () => {
    expect(kinds("select /*!80000 sql_no_cache */ a")).toEqual([
      ["word", "select"],
      ["word", "sql_no_cache"],
      ["word", "a"],
    ])
  })
})

describe("tokenizeSql with ANSI quotes (Athena)", () => {
  it("reads double-quoted identifiers with doubled quotes and reports unclosed ones", () => {
    expect(tokenizeSql('"a""b" "open', ANSI_SYNTAX)).toEqual([
      { kind: "quoted", from: 0, to: 6, value: 'a"b', closed: true },
      { kind: "quoted", from: 7, to: 12, value: "open", closed: false },
    ])
  })

  it("reads a qualified name as identifiers and dots, without backslash escapes", () => {
    expect(tokenizeSql('FROM "db"."t\\" x', ANSI_SYNTAX).map((t) => [t.kind, t.value])).toEqual([
      ["word", "FROM"],
      ["quoted", "db"],
      ["punct", "."],
      ["quoted", "t\\"],
      ["word", "x"],
    ])
  })

  it("keeps single-quoted strings and MySQL's double-quoted strings as strings", () => {
    expect(tokenizeSql("'a\"b'", ANSI_SYNTAX).map((t) => t.kind)).toEqual(["string"])
    expect(tokenizeSql('"db"."t"').map((t) => t.kind)).toEqual(["string", "punct", "string"])
  })
})
