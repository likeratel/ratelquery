import { describe, expect, it } from "vitest"
import { ANSI_SYNTAX, splitStatements, statementAtCursor } from "./sqlContext"

const texts = (sql: string) => splitStatements(sql).map((s) => s.text)

describe("splitStatements", () => {
  it("splits on semicolons and keeps the terminator", () => {
    expect(texts("select 1; select 2;")).toEqual(["select 1;", "select 2;"])
    expect(texts("select 1;\nselect 2")).toEqual(["select 1;", "select 2"])
  })

  it("ignores semicolons inside strings, identifiers and comments", () => {
    const sql = [
      "select ';', \"a;b\", `c;d` from t; -- trailing; comment",
      "# hash; comment",
      "/* block ; */ select 'it''s; ok', 'esc\\'; still';",
    ].join("\n")
    expect(texts(sql)).toEqual([
      "select ';', \"a;b\", `c;d` from t;",
      "select 'it''s; ok', 'esc\\'; still';",
    ])
  })

  it("treats -- without a following space as an operator, like MySQL", () => {
    expect(texts("select 1--1; select 2")).toEqual(["select 1--1;", "select 2"])
  })

  it("starts a -- comment only before ASCII whitespace, like the backend splitter", () => {
    // U+3000 (ideographic space) and NBSP are not comment gaps: the `;` still splits.
    expect(texts("select 1 --\u3000; DROP TABLE t")).toEqual(["select 1 --\u3000;", "DROP TABLE t"])
    expect(texts("select 1 --\u00a0; DROP TABLE t")).toEqual(["select 1 --\u00a0;", "DROP TABLE t"])
    expect(texts("select 1 --\t; DROP TABLE t")).toEqual(["select 1"])
    expect(texts("select 1 --\f; x\nselect 2")).toEqual(["select 1 --\f; x\nselect 2"])
    expect(texts("select 1 --")).toEqual(["select 1"])
  })

  it("drops empty and comment-only segments", () => {
    expect(texts(";; -- nothing\n  ;")).toEqual([])
    expect(texts("")).toEqual([])
  })

  it("counts an executable comment as a statement, like the backend", () => {
    const sql = "/*!40101 SET NAMES utf8mb4 */;\n/* plain */;\n/*!40014 SET FOREIGN_KEY_CHECKS=0 */"
    expect(texts(sql)).toEqual([
      "/*!40101 SET NAMES utf8mb4 */;",
      "/*!40014 SET FOREIGN_KEY_CHECKS=0 */",
    ])
  })

  it("does not split on a semicolon inside an executable comment", () => {
    expect(texts("/*!50000 SELECT 1; */ ; SELECT 2")).toEqual([
      "/*!50000 SELECT 1; */ ;",
      "SELECT 2",
    ])
  })

  it("reports offsets into the original text", () => {
    const sql = "  select 1 ;  select 2"
    const [first, second] = splitStatements(sql)
    expect(sql.slice(first.from, first.to)).toBe("select 1 ;")
    expect(sql.slice(second.from, second.to)).toBe("select 2")
  })
})

describe("statementAtCursor", () => {
  const sql = "select 1;\n\nselect 2;\nselect 3"

  it("finds the statement under the cursor", () => {
    expect(statementAtCursor(sql, 3)?.text).toBe("select 1;")
    expect(statementAtCursor(sql, sql.indexOf("2"))?.text).toBe("select 2;")
    expect(statementAtCursor(sql, sql.length)?.text).toBe("select 3")
  })

  it("keeps the statement that just ended when the cursor is right after its semicolon", () => {
    expect(statementAtCursor(sql, sql.indexOf(";") + 1)?.text).toBe("select 1;")
    expect(statementAtCursor("select 1;   ", 11)?.text).toBe("select 1;")
  })

  it("picks the next statement from a blank line before it", () => {
    expect(statementAtCursor(sql, sql.indexOf("\n\n") + 1)?.text).toBe("select 2;")
  })

  it("falls back to the previous statement in trailing whitespace", () => {
    expect(statementAtCursor("select 1;\n\n", 11)?.text).toBe("select 1;")
  })

  it("selects an executable comment statement under the cursor", () => {
    const text = "SELECT 1;\n/*!50000 DELETE FROM t */;\n/* note */"
    expect(statementAtCursor(text, text.indexOf("DELETE"))?.text).toBe("/*!50000 DELETE FROM t */;")
    expect(statementAtCursor(text, text.length)?.text).toBe("/*!50000 DELETE FROM t */;")
  })

  it("returns null when there is nothing to run", () => {
    expect(statementAtCursor("  -- only a comment", 5)).toBeNull()
  })
})

describe("ANSI quotes (Athena)", () => {
  it("ends a double-quoted identifier at its quote, a backslash being part of the name", () => {
    const sql = 'SELECT "a\\"; SELECT 2'
    expect(splitStatements(sql, ANSI_SYNTAX).map((s) => s.text)).toEqual([
      'SELECT "a\\";',
      "SELECT 2",
    ])
    // MySQL reads the backslash as an escape, so the `;` is inside the string.
    expect(splitStatements(sql).map((s) => s.text)).toEqual([sql])
  })

  it("finds the statement at the cursor with the same rule", () => {
    const sql = 'SELECT "a\\"; SELECT 2'
    expect(statementAtCursor(sql, sql.length, ANSI_SYNTAX)?.text).toBe("SELECT 2")
  })
})
