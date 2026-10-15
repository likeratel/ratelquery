import { describe, expect, it } from "vitest"
import type { IndexInfo, SchemaColumn, TableDetails } from "../../lib/mysql"
import { columnExtra, columnKey, tableFacts } from "./details"

const column = (name: string, extra: Partial<SchemaColumn> = {}): SchemaColumn => ({
  name,
  typeName: "int",
  nullable: false,
  isPrimary: false,
  isAutoIncrement: false,
  defaultValue: null,
  ...extra,
})

const index = (name: string, columns: string[], unique = false): IndexInfo => ({
  name,
  unique,
  columns,
  type: "BTREE",
})

describe("columnKey", () => {
  const indexes = [
    index("PRIMARY", ["id"], true),
    index("email", ["email"], true),
    index("name_city", ["name", "city"], true),
    index("city", ["city"]),
  ]

  it("follows COLUMN_KEY rules", () => {
    expect(columnKey(column("id", { isPrimary: true }), indexes)).toBe("PRI")
    expect(columnKey(column("email"), indexes)).toBe("UNI")
    // Leading column of a multi-column unique index is MUL, like MySQL reports it.
    expect(columnKey(column("name"), indexes)).toBe("MUL")
    expect(columnKey(column("city"), indexes)).toBe("MUL")
    expect(columnKey(column("note"), indexes)).toBe("")
  })

  it("marks auto increment as extra", () => {
    expect(columnExtra(column("id", { isAutoIncrement: true }))).toBe("auto_increment")
    expect(columnExtra(column("id"))).toBe("")
  })
})

describe("tableFacts", () => {
  const base: TableDetails = {
    database: "app",
    table: "users",
    kind: "table",
    engine: "InnoDB",
    rowEstimate: 12345,
    dataLength: 2048,
    collation: "utf8mb4_0900_ai_ci",
    comment: "",
    columns: [],
    indexes: [],
    foreignKeys: [],
    ddl: "",
  }

  it("lists what the server reported", () => {
    expect(tableFacts(base).map((f) => f.label)).toEqual([
      "Kind",
      "Engine",
      "Rows",
      "Size",
      "Collation",
    ])
    expect(tableFacts(base)[3].value).toBe("2.0 KB")
  })

  it("leaves out unknown facts for a view", () => {
    const view = { ...base, kind: "view" as const, engine: null, rowEstimate: null }
    const facts = tableFacts({ ...view, dataLength: null, collation: null })
    expect(facts).toEqual([{ label: "Kind", value: "View" }])
  })
})
