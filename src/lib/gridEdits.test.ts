import { describe, expect, it } from "vitest"
import {
  addInsert,
  buildRowChanges,
  displayRows,
  editDatabase,
  editSchemaDatabases,
  EMPTY_EDITS,
  findByName,
  pendingCount,
  removeInsert,
  resolveEditTarget,
  setCellEdit,
  setInsertValue,
  toggleRowDelete,
  type EditTarget,
} from "./gridEdits"
import type { Cell, ColumnInfo, QueryResult, SchemaSnapshot } from "./mysql"

// The backend never reports a column's table (`table: null`), so these go through the same
// statement-based path as the app.
const columns: ColumnInfo[] = [
  { name: "id", typeName: "INT", table: null, nullable: false },
  { name: "email", typeName: "VARCHAR", table: null, nullable: false },
  { name: "note", typeName: "TEXT", table: null, nullable: true },
]

const SELECT_USERS = "select id, email, note from users where id > 0"

const schemaColumn = (name: string, isPrimary = false) => ({
  name,
  typeName: "varchar(255)",
  nullable: !isPrimary,
  isPrimary,
  isAutoIncrement: isPrimary,
  defaultValue: null,
})

const schema: SchemaSnapshot = {
  database: "app",
  fetchedAt: "2026-01-01T00:00:00Z",
  tables: [
    {
      name: "users",
      kind: "table",
      columns: [schemaColumn("id", true), schemaColumn("email"), schemaColumn("note")],
    },
    { name: "logs", kind: "table", columns: [schemaColumn("msg")] },
    { name: "v_users", kind: "view", columns: [schemaColumn("id")] },
  ],
}

const rows: Cell[][] = [
  [{ t: "int", v: "1" }, { t: "str", v: "a@x" }, { t: "null" }],
  [
    { t: "int", v: "2" },
    { t: "str", v: "b@x" },
    { t: "str", v: "hi" },
  ],
]

const target = (): EditTarget => {
  const resolved = resolveEditTarget(columns, schema, "app", SELECT_USERS)
  if (!resolved.editable) throw new Error(resolved.reason)
  return resolved.target
}

describe("resolveEditTarget", () => {
  it("accepts a single base table with its primary key selected", () => {
    expect(target()).toMatchObject({ database: "app", table: "users", keyIndexes: [0] })
  })

  it("accepts a table qualified with the same database", () => {
    const resolved = resolveEditTarget(columns, schema, "app", "select * from `app`.`users`")
    expect(resolved).toMatchObject({ editable: true, target: { table: "users" } })
  })

  it("rejects results that cannot be keyed back to one row", () => {
    const joined = "select u.id, o.email from users u join orders o on o.user_id = u.id"
    expect(resolveEditTarget(columns.slice(0, 2), schema, "app", joined)).toEqual({
      editable: false,
      reason: "Read only: rows don't come from a single table",
    })
    expect(
      resolveEditTarget(columns.slice(1), schema, "app", "select email, note from users").editable,
    ).toBe(false)
    expect(resolveEditTarget(columns.slice(0, 1), schema, "app", "select id from v_users")).toEqual(
      { editable: false, reason: "Read only: v_users isn't a base table in app" },
    )
    const noKey = [{ name: "msg", typeName: "TEXT", table: null, nullable: true }]
    expect(resolveEditTarget(noKey, schema, "app", "select msg from logs")).toEqual({
      editable: false,
      reason: "Read only: logs has no primary key",
    })
    const aliased = [columns[0], { ...columns[1], name: "mail" }]
    const aliasSql = "select id, email as mail from users"
    expect(resolveEditTarget(aliased, schema, "app", aliasSql).editable).toBe(false)
    expect(resolveEditTarget(columns, schema, "other", SELECT_USERS).editable).toBe(false)
    expect(
      resolveEditTarget(columns, schema, "app", "select id, email, note from shop.users").editable,
    ).toBe(false)
    expect(resolveEditTarget(columns, schema, "app", "").editable).toBe(false)
    expect(resolveEditTarget(columns, null, null, SELECT_USERS).editable).toBe(false)
  })
})

describe("edit reducers", () => {
  it("records cell edits and drops edits that restore the original value", () => {
    const edited = setCellEdit(EMPTY_EDITS, rows, 0, 1, { t: "str", v: "new@x" })
    expect(edited.updates).toEqual({ 0: { 1: { t: "str", v: "new@x" } } })
    expect(pendingCount(edited)).toBe(1)
    const restored = setCellEdit(edited, rows, 0, 1, { t: "str", v: "a@x" })
    expect(restored.updates).toEqual({})
    expect(EMPTY_EDITS.updates).toEqual({})
  })

  it("toggles deletes and counts a deleted, edited row once", () => {
    const edited = setCellEdit(EMPTY_EDITS, rows, 1, 2, { t: "null" })
    const deleted = toggleRowDelete(edited, 1)
    expect(deleted.deletes).toEqual([1])
    expect(pendingCount(deleted)).toBe(1)
    expect(toggleRowDelete(deleted, 1).deletes).toEqual([])
  })

  it("adds, fills and removes inserted rows", () => {
    const added = addInsert(EMPTY_EDITS, "n1")
    const filled = setInsertValue(added, "n1", 1, { t: "str", v: "c@x" })
    expect(filled.inserts).toEqual([{ id: "n1", values: { 1: { t: "str", v: "c@x" } } }])
    expect(added.inserts[0].values).toEqual({})
    expect(removeInsert(filled, "n1").inserts).toEqual([])
  })
})

describe("buildRowChanges", () => {
  it("keys updates and deletes on the original primary key values", () => {
    let edits = setCellEdit(EMPTY_EDITS, rows, 0, 0, { t: "int", v: "10" })
    edits = setCellEdit(edits, rows, 0, 2, { t: "str", v: "n" })
    edits = toggleRowDelete(edits, 1)
    edits = setInsertValue(addInsert(edits, "n1"), "n1", 1, { t: "str", v: "c@x" })

    expect(buildRowChanges(edits, target(), rows)).toEqual([
      { type: "delete", key: { id: { t: "int", v: "2" } } },
      {
        type: "update",
        key: { id: { t: "int", v: "1" } },
        set: { id: { t: "int", v: "10" }, note: { t: "str", v: "n" } },
      },
      { type: "insert", values: { email: { t: "str", v: "c@x" } } },
    ])
  })

  it("sends only the delete for a row that was edited and then deleted", () => {
    const edits = toggleRowDelete(setCellEdit(EMPTY_EDITS, rows, 0, 1, { t: "str", v: "z" }), 0)
    expect(buildRowChanges(edits, target(), rows)).toEqual([
      { type: "delete", key: { id: { t: "int", v: "1" } } },
    ])
  })

  it("names columns as the schema does, not as the query spelled them", () => {
    const upper = columns.map((c) => ({ ...c, name: c.name.toUpperCase() }))
    const resolved = resolveEditTarget(upper, schema, "app", "SELECT ID, EMAIL, NOTE FROM USERS")
    if (!resolved.editable) throw new Error(resolved.reason)
    const edits = setCellEdit(EMPTY_EDITS, rows, 0, 1, { t: "str", v: "z" })
    expect(buildRowChanges(edits, resolved.target, rows)).toEqual([
      { type: "update", key: { id: { t: "int", v: "1" } }, set: { email: { t: "str", v: "z" } } },
    ])
  })
})

describe("case-insensitive names", () => {
  it("matches table and column names that differ only in case, using the schema's spelling", () => {
    const upper = columns.map((c) => ({ ...c, name: c.name.toUpperCase() }))
    expect(resolveEditTarget(upper, schema, "app", "select * from `Users` limit 5")).toMatchObject({
      editable: true,
      target: { table: "users", keyIndexes: [0] },
    })
    expect(
      resolveEditTarget(columns, schema, "app", "select * from APP.users where id = 1"),
    ).toMatchObject({ editable: true, target: { database: "app", table: "users" } })
  })

  it("stays read only when the case-folded name is ambiguous or repeated", () => {
    const twin = {
      ...schema,
      tables: [...schema.tables, { ...schema.tables[0], name: "USERS" }],
    }
    expect(resolveEditTarget(columns, twin, "app", "select * from Users").editable).toBe(false)
    const repeated = [...columns, { ...columns[1], name: "EMAIL" }]
    expect(resolveEditTarget(repeated, schema, "app", "select *, EMAIL from users")).toEqual({
      editable: false,
      reason: "Read only: some columns are aliased or computed",
    })
  })

  it("finds an exact name before a case-folded one", () => {
    const names = ["Shop", "shop", "app"]
    expect(findByName(names, "shop", (n) => n)).toBe("shop")
    expect(findByName(names, "APP", (n) => n)).toBe("app")
    expect(findByName(names, "SHOP", (n) => n)).toBeUndefined()
  })
})

describe("editDatabase", () => {
  it("uses the database a table is qualified with, spelled as the session knows it", () => {
    expect(editDatabase("select * from users", "app")).toBe("app")
    expect(editDatabase("select * from users", null)).toBeNull()
    expect(editDatabase("select * from `Shop`.users", null, ["app", "shop"])).toBe("shop")
    expect(editDatabase("select * from shop.users", "app")).toBe("shop")
    expect(editDatabase("select * from a join b on a.id = b.id", "app")).toBe("app")
  })

  it("lists the databases a run's editable results need schemas for", () => {
    const rowsOf = (statement: string): QueryResult => ({
      kind: "rows",
      columns,
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: 1,
      reconnected: false,
      statement,
    })
    const results = [
      rowsOf("select * from users"),
      rowsOf("select * from SHOP.users"),
      rowsOf("select * from app.logs"),
      rowsOf("select 1"),
      {
        kind: "exec",
        affectedRows: 1,
        lastInsertId: null,
        elapsedMs: 1,
        reconnected: false,
        statement: "update other.t set a = 1",
      } as QueryResult,
    ]
    expect(editSchemaDatabases(results, "app", ["app", "shop"])).toEqual(["app", "shop"])
    expect(editSchemaDatabases([rowsOf("select * from users")], null)).toEqual([])
  })
})

describe("displayRows", () => {
  it("overlays edits, flags deletes and appends inserts", () => {
    let edits = setCellEdit(EMPTY_EDITS, rows, 0, 2, { t: "str", v: "x" })
    edits = toggleRowDelete(edits, 1)
    edits = setInsertValue(addInsert(edits, "n1"), "n1", 0, { t: "int", v: "3" })
    const display = displayRows(rows, 3, edits)
    expect(display).toHaveLength(3)
    expect(display[0].cells[2]).toEqual({ t: "str", v: "x" })
    expect(display[0].changed).toEqual([false, false, true])
    expect(display[1].deleted).toBe(true)
    expect(display[2]).toMatchObject({
      ref: { kind: "insert", id: "n1" },
      cells: [{ t: "int", v: "3" }, undefined, undefined],
      changed: [true, false, false],
    })
    expect(rows[0][2]).toEqual({ t: "null" })
  })
})
