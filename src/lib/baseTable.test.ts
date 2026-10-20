import { describe, expect, it } from "vitest"
import { inferBaseTable } from "./baseTable"

describe("inferBaseTable", () => {
  it("finds the table in a plain select", () => {
    expect(inferBaseTable("SELECT * FROM customers")).toEqual({
      database: null,
      table: "customers",
    })
    expect(
      inferBaseTable("select id, name from `orders` where id > 1 order by id limit 10"),
    ).toEqual({
      database: null,
      table: "orders",
    })
    expect(inferBaseTable("SELECT * FROM sample.customers AS c WHERE c.id = 1")).toEqual({
      database: "sample",
      table: "customers",
    })
    expect(inferBaseTable("SELECT * FROM `my db`.`my table`")).toEqual({
      database: "my db",
      table: "my table",
    })
  })

  it("keeps commas outside the FROM list from making a select read only", () => {
    const users = { database: null, table: "users" }
    for (const sql of [
      "SELECT * FROM users ORDER BY name, id DESC",
      "select * from users order by name asc, id desc limit 5",
      "SELECT * FROM users WHERE id IN (1, 2) ORDER BY id",
      "SELECT * FROM `users` LIMIT 10, 20",
      "SELECT * FROM users LIMIT 10 OFFSET 5;",
      "/* list */ -- users\nSELECT * FROM users u WHERE u.id > 1;",
    ]) {
      expect(inferBaseTable(sql), sql).toEqual(users)
    }
  })

  it("reads doubled backticks inside a quoted name", () => {
    expect(inferBaseTable("SELECT * FROM `we``ird` LIMIT 1")).toEqual({
      database: null,
      table: "we`ird",
    })
    expect(inferBaseTable("SELECT * FROM `d``b`.`t` , `u`")).toBeNull()
  })

  it("ignores comments and strings", () => {
    expect(inferBaseTable("-- from nowhere\nSELECT * FROM t WHERE name = 'x join y'")).toEqual({
      database: null,
      table: "t",
    })
  })

  it("refuses anything that is not a single-table read", () => {
    const readOnly = [
      "SELECT a.id FROM a JOIN b ON a.id = b.a_id",
      "SELECT * FROM a, b",
      "SELECT * FROM a UNION SELECT * FROM b",
      "SELECT COUNT(*) FROM a GROUP BY x",
      "SELECT DISTINCT x FROM a",
      "SELECT * FROM (SELECT * FROM a) t",
      "SHOW TABLES",
      "UPDATE a SET x = 1",
      "SELECT 1",
      // Comment markers inside strings must not hide a UNION.
      "SELECT * FROM a WHERE tag = '#x' UNION SELECT * FROM b",
      "SELECT * FROM a WHERE tag = 'a -- b' UNION ALL SELECT * FROM b",
      "SELECT * FROM a WHERE note = '/*' UNION SELECT * FROM b WHERE note = '*/'",
      // Quotes inside comments must not swallow the rest of the statement.
      "SELECT * FROM a /* it's */ JOIN b ON a.id = b.a_id",
    ]
    for (const sql of readOnly) expect(inferBaseTable(sql), sql).toBeNull()
  })
})
