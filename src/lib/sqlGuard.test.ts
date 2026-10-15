import { describe, expect, it } from "vitest"
import { classifyDanger, maskSql, withDefaultLimit } from "./sqlGuard"

describe("maskSql", () => {
  it("keeps the length and blanks strings, identifiers and comments", () => {
    const sql = "SELECT 'limit', `limit` /* limit */ -- limit\nFROM t"
    const masked = maskSql(sql)
    expect(masked).toHaveLength(sql.length)
    expect(masked).not.toMatch(/limit/i)
    expect(masked).toMatch(/^SELECT '     ', ` {5}`/)
  })
})

describe("withDefaultLimit", () => {
  const add = (sql: string) => withDefaultLimit(sql, 1000)

  it("appends a LIMIT to a SELECT without one", () => {
    expect(add("SELECT * FROM users")).toBe("SELECT * FROM users LIMIT 1000")
    expect(add("select 1")).toBe("select 1 LIMIT 1000")
  })

  it("keeps the terminating semicolon and trailing comments after the LIMIT", () => {
    expect(add("SELECT * FROM users;")).toBe("SELECT * FROM users LIMIT 1000;")
    expect(add("SELECT * FROM users  ;  ")).toBe("SELECT * FROM users LIMIT 1000  ;  ")
    expect(add("SELECT * FROM users -- recent\n")).toBe(
      "SELECT * FROM users LIMIT 1000 -- recent\n",
    )
    expect(add("SELECT * FROM users /* all */;")).toBe("SELECT * FROM users LIMIT 1000 /* all */;")
  })

  it("leaves a statement with a top-level LIMIT alone", () => {
    expect(add("SELECT * FROM users LIMIT 10")).toBe("SELECT * FROM users LIMIT 10")
    expect(add("SELECT * FROM users limit 5, 10;")).toBe("SELECT * FROM users limit 5, 10;")
    expect(add("(SELECT a FROM t) UNION (SELECT a FROM u) LIMIT 3")).toBe(
      "(SELECT a FROM t) UNION (SELECT a FROM u) LIMIT 3",
    )
  })

  it("ignores LIMIT inside subqueries, strings, identifiers and comments", () => {
    expect(add("SELECT * FROM (SELECT id FROM t LIMIT 5) x")).toBe(
      "SELECT * FROM (SELECT id FROM t LIMIT 5) x LIMIT 1000",
    )
    expect(add("SELECT 'LIMIT 1' AS s")).toBe("SELECT 'LIMIT 1' AS s LIMIT 1000")
    expect(add("SELECT `limit` FROM t")).toBe("SELECT `limit` FROM t LIMIT 1000")
    expect(add("SELECT a /* LIMIT 1 */ FROM t")).toBe("SELECT a /* LIMIT 1 */ FROM t LIMIT 1000")
  })

  it("limits a UNION as a whole", () => {
    expect(add("SELECT a FROM t UNION ALL SELECT a FROM u")).toBe(
      "SELECT a FROM t UNION ALL SELECT a FROM u LIMIT 1000",
    )
    expect(add("(SELECT a FROM t) UNION (SELECT a FROM u)")).toBe(
      "(SELECT a FROM t) UNION (SELECT a FROM u) LIMIT 1000",
    )
  })

  it("limits the main SELECT of a CTE", () => {
    expect(add("WITH r AS (SELECT * FROM t LIMIT 2) SELECT * FROM r")).toBe(
      "WITH r AS (SELECT * FROM t LIMIT 2) SELECT * FROM r LIMIT 1000",
    )
    expect(add("WITH RECURSIVE n AS (SELECT 1) SELECT * FROM n;")).toBe(
      "WITH RECURSIVE n AS (SELECT 1) SELECT * FROM n LIMIT 1000;",
    )
  })

  it("puts the LIMIT before a locking clause", () => {
    expect(add("SELECT * FROM t WHERE id = 1 FOR UPDATE")).toBe(
      "SELECT * FROM t WHERE id = 1 LIMIT 1000 FOR UPDATE",
    )
    expect(add("SELECT * FROM t FOR SHARE NOWAIT;")).toBe(
      "SELECT * FROM t LIMIT 1000 FOR SHARE NOWAIT;",
    )
    expect(add("SELECT * FROM t LOCK IN SHARE MODE")).toBe(
      "SELECT * FROM t LIMIT 1000 LOCK IN SHARE MODE",
    )
  })

  it("leaves INTO, non-SELECT and DML statements alone", () => {
    const unchanged = [
      "SELECT * FROM t INTO OUTFILE '/tmp/t.csv'",
      "SELECT COUNT(*) INTO @n FROM t",
      "SHOW TABLES",
      "EXPLAIN SELECT * FROM t",
      "DESCRIBE t",
      "INSERT INTO t SELECT * FROM u",
      "UPDATE t SET a = (SELECT 1)",
      "WITH r AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM r)",
      "",
    ]
    for (const sql of unchanged) expect(add(sql)).toBe(sql)
  })

  it("uses the given limit", () => {
    expect(withDefaultLimit("SELECT 1", 25)).toBe("SELECT 1 LIMIT 25")
  })
})

describe("classifyDanger", () => {
  it("flags UPDATE and DELETE without a top-level WHERE", () => {
    expect(classifyDanger("UPDATE users SET active = 0")).toMatch(/UPDATE without WHERE/)
    expect(classifyDanger("delete from users;")).toMatch(/DELETE without WHERE/)
    expect(classifyDanger("DELETE FROM t WHERE id IN (SELECT id FROM u)")).toBeNull()
    expect(classifyDanger("UPDATE t SET a = 1 WHERE id = 2")).toBeNull()
  })

  it("does not count a WHERE inside a subquery, string or comment", () => {
    expect(classifyDanger("UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)")).not.toBeNull()
    expect(classifyDanger("UPDATE t SET note = 'where'")).not.toBeNull()
    expect(classifyDanger("DELETE FROM t -- WHERE id = 1")).not.toBeNull()
  })

  it("flags DROP, TRUNCATE and ALTER", () => {
    expect(classifyDanger("DROP TABLE users")).toMatch(/DROP/)
    expect(classifyDanger("drop database shop;")).toMatch(/DROP/)
    expect(classifyDanger("TRUNCATE TABLE logs")).toMatch(/TRUNCATE/)
    expect(classifyDanger("ALTER TABLE t ADD COLUMN c INT")).toMatch(/ALTER/)
  })

  it("flags a CTE whose main statement is an unbounded DELETE", () => {
    expect(classifyDanger("WITH r AS (SELECT 1) DELETE FROM t")).toMatch(/DELETE/)
  })

  it("passes reads and bounded writes", () => {
    expect(classifyDanger("SELECT * FROM t")).toBeNull()
    expect(classifyDanger("INSERT INTO t VALUES (1)")).toBeNull()
    expect(classifyDanger("-- DROP TABLE t\nSELECT 1")).toBeNull()
    expect(classifyDanger("SELECT 'DROP TABLE t'")).toBeNull()
  })
})
