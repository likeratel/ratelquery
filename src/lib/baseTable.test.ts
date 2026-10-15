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
    ]
    for (const sql of readOnly) expect(inferBaseTable(sql), sql).toBeNull()
  })
})
