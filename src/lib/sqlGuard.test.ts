import { describe, expect, it } from "vitest"
import { ATHENA_DIALECT } from "./sqlDialect"
import { classifyDanger, maskSql, withDefaultLimit } from "./sqlGuard"

describe("maskSql", () => {
  it("keeps the length and blanks strings, identifiers and comments", () => {
    const sql = "SELECT 'limit', `limit` /* limit */ -- limit\nFROM t"
    const masked = maskSql(sql)
    expect(masked).toHaveLength(sql.length)
    expect(masked).not.toMatch(/limit/i)
    expect(masked).toMatch(/^SELECT '     ', ` {5}`/)
  })

  it("keeps the body of an executable comment as code and blanks only its markers", () => {
    const sql = "/*!40101 SET x = 'a' */ /* skip */"
    const masked = maskSql(sql)
    expect(masked).toHaveLength(sql.length)
    expect(masked).toBe(`${" ".repeat(9)}SET x = ' '`.padEnd(sql.length))
    expect(maskSql("/*! SELECT 1")).toBe("    SELECT 1")
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

  it("puts the LIMIT inside an executable comment, before its closing marker", () => {
    expect(add("/*!40101 SELECT * FROM t */")).toBe("/*!40101 SELECT * FROM t LIMIT 1000 */")
    expect(add("/*!40101 SELECT * FROM t */;")).toBe("/*!40101 SELECT * FROM t LIMIT 1000 */;")
    expect(add("/*!40101 SELECT * FROM t LIMIT 5 */")).toBe("/*!40101 SELECT * FROM t LIMIT 5 */")
  })

  it("leaves a fully parenthesized query and PROCEDURE alone", () => {
    const unchanged = [
      "(SELECT * FROM t)",
      "(SELECT * FROM t);",
      "((SELECT a FROM t) UNION (SELECT a FROM u))",
      "SELECT * FROM t PROCEDURE ANALYSE()",
    ]
    for (const sql of unchanged) expect(add(sql)).toBe(sql)
    expect(add("(SELECT a FROM t) UNION (SELECT a FROM u);")).toBe(
      "(SELECT a FROM t) UNION (SELECT a FROM u) LIMIT 1000;",
    )
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
    expect(classifyDanger("ALTER TABLE t ADD COLUMN c INT")).toBe(
      "ALTER TABLE changes a definition",
    )
  })

  it("names the ALTER target and falls back to a general reason", () => {
    expect(classifyDanger("alter user bob identified by 'x'")).toBe(
      "ALTER USER changes a definition",
    )
    expect(classifyDanger("ALTER VIEW v AS SELECT 1")).toBe("ALTER VIEW changes a definition")
    expect(classifyDanger("ALTER ONLINE TABLE t ADD c INT")).toBe("ALTER changes a definition")
  })

  it("flags RENAME TABLE", () => {
    expect(classifyDanger("RENAME TABLE a TO b, c TO d")).toMatch(/RENAME TABLE/)
    expect(classifyDanger("rename table a to b;")).toMatch(/RENAME TABLE/)
    expect(classifyDanger("RENAME USER a TO b")).toBeNull()
  })

  it("flags a destructive statement inside an executable comment", () => {
    expect(classifyDanger("/*!50000 DELETE FROM t */")).toMatch(/DELETE without WHERE/)
    expect(classifyDanger("/*!50000 DROP TABLE t */;")).toMatch(/DROP/)
    expect(classifyDanger("/* DELETE FROM t */ SELECT 1")).toBeNull()
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

describe("Athena rules", () => {
  const limit = (sql: string) => withDefaultLimit(sql, 1000, ATHENA_DIALECT)
  const danger = (sql: string) => classifyDanger(sql, ATHENA_DIALECT)

  it("leaves a SELECT with FETCH FIRST or OFFSET ... FETCH alone", () => {
    expect(limit("SELECT * FROM t FETCH FIRST 10 ROWS ONLY")).toBe(
      "SELECT * FROM t FETCH FIRST 10 ROWS ONLY",
    )
    expect(limit("SELECT * FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY")).toBe(
      "SELECT * FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
    )
    // A FETCH inside a subquery doesn't bound the outer SELECT.
    expect(limit("SELECT * FROM (SELECT * FROM t FETCH FIRST 1 ROWS ONLY) s")).toBe(
      "SELECT * FROM (SELECT * FROM t FETCH FIRST 1 ROWS ONLY) s LIMIT 1000",
    )
    expect(limit('SELECT * FROM "sales"."orders"')).toBe(
      'SELECT * FROM "sales"."orders" LIMIT 1000',
    )
    expect(limit('SELECT "fetch first" FROM t')).toBe('SELECT "fetch first" FROM t LIMIT 1000')
  })

  it("flags statements that write to S3 or the catalog", () => {
    expect(danger("CREATE TABLE t AS SELECT * FROM s")).toMatch(/CREATE TABLE AS/)
    expect(danger("create table if not exists t with (format = 'PARQUET') as select 1")).toMatch(
      /CREATE TABLE AS/,
    )
    expect(danger('INSERT INTO "sales"."t" SELECT * FROM s')).toMatch(/INSERT/)
    expect(danger("WITH r AS (SELECT 1) INSERT INTO t SELECT * FROM r")).toMatch(/INSERT/)
    expect(danger("UNLOAD (SELECT * FROM t) TO 's3://b/p/' WITH (format = 'PARQUET')")).toMatch(
      /UNLOAD/,
    )
    expect(danger("MSCK REPAIR TABLE logs")).toMatch(/MSCK REPAIR/)
  })

  it("keeps the shared rules and lets reads through", () => {
    expect(danger("DROP TABLE t")).toMatch(/DROP/)
    expect(danger("ALTER TABLE t ADD COLUMNS (c int)")).toBe("ALTER TABLE changes a definition")
    expect(danger("DELETE FROM t")).toMatch(/DELETE without WHERE/)
    expect(danger("CREATE EXTERNAL TABLE t (a int) LOCATION 's3://b/'")).toBeNull()
    expect(danger("SELECT 'INSERT' AS \"unload\" FROM t")).toBeNull()
    expect(danger("SHOW PARTITIONS logs")).toBeNull()
  })

  it("keeps MySQL rules unchanged", () => {
    expect(classifyDanger("INSERT INTO t VALUES (1)")).toBeNull()
    expect(classifyDanger("CREATE TABLE t AS SELECT 1")).toBeNull()
    expect(withDefaultLimit("SELECT * FROM t FETCH FIRST 1 ROWS ONLY", 10)).toBe(
      "SELECT * FROM t FETCH FIRST 1 ROWS ONLY LIMIT 10",
    )
  })
})
