import { describe, expect, it } from "vitest"
import type { SchemaColumn, SchemaSnapshot, SchemaTable } from "../../../lib/mysql"
import { MYSQL_DIALECT } from "../../../lib/sqlDialect"
import { identifierAt } from "../../../lib/sqlScope"
import type { SchemaCatalog } from "./catalog"
import { HOVER_COLUMN_LIMIT, hoverCards, hoverTarget } from "./hoverCard"
import { createLookup } from "./resolve"

const column = (name: string, typeName: string, extra: Partial<SchemaColumn> = {}) => ({
  name,
  typeName,
  nullable: false,
  isPrimary: false,
  isAutoIncrement: false,
  defaultValue: null,
  ...extra,
})

const table = (name: string, columns: SchemaColumn[], kind: SchemaTable["kind"] = "table") => ({
  name,
  kind,
  columns,
})

const snapshot = (database: string, tables: SchemaTable[]): SchemaSnapshot => ({
  database,
  tables,
  fetchedAt: "2026-11-01T00:00:00Z",
})

const SPAM = snapshot("spam", [
  table("spam_xray", [
    column("id", "bigint unsigned", { isPrimary: true, isAutoIncrement: true }),
    column("smStatus", "enum('SMISHING','NORMAL')", {
      nullable: true,
      defaultValue: "NORMAL",
      comment: "classifier verdict",
    }),
  ]),
  table("xray_view", [column("id", "bigint")], "view"),
])

const APP = snapshot("app", [
  table("users", [column("id", "int"), column("name", "varchar(50)", { nullable: true })]),
  table("orders", [column("id", "int"), column("user_id", "int")]),
  table(
    "wide",
    Array.from({ length: HOVER_COLUMN_LIMIT + 3 }, (_, i) => column(`c${i}`, "int")),
  ),
])

const catalog: SchemaCatalog = {
  currentDatabase: "app",
  databases: ["app", "spam", "shop"],
  schemas: { app: APP, spam: SPAM },
}

/** Cards for the name at `|`, and the databases whose schema was missing. */
function hoverAt(marked: string, schemas = catalog.schemas) {
  const pos = marked.indexOf("|")
  const sql = marked.slice(0, pos) + marked.slice(pos + 1)
  const id = identifierAt(sql, pos)
  if (!id) return { cards: null, missing: [] }
  const missing = new Set<string>()
  const target = hoverTarget(id, createLookup({ ...catalog, schemas }, MYSQL_DIALECT, missing))
  return { cards: target ? hoverCards(target) : null, missing: [...missing] }
}

describe("hover cards", () => {
  it("describes a column of a qualified table, as in the user's example", () => {
    const { cards } = hoverAt("select count(*) from spam.spam_xray where smSt|atus = 'SMISHING'")
    expect(cards).toEqual([
      {
        title: "smStatus",
        badge: "column",
        location: "spam.spam_xray",
        type: "enum('SMISHING','NORMAL')",
        facts: ["NULL", "DEFAULT NORMAL"],
        comment: "classifier verdict",
      },
    ])
    expect(hoverAt("select i|d from spam.spam_xray").cards?.[0]?.facts).toEqual([
      "PRIMARY KEY",
      "AUTO_INCREMENT",
      "NOT NULL",
    ])
  })

  it("matches column names ignoring case, through aliases", () => {
    expect(hoverAt("select x.SMSTA|TUS from spam.spam_xray x").cards?.[0]?.title).toBe("smStatus")
  })

  it("shows every table an unqualified column could come from", () => {
    const { cards } = hoverAt("select i|d from users u join orders o on o.user_id = u.id")
    expect(cards?.map((c) => c.location)).toEqual(["app.users", "app.orders"])
  })

  it("describes tables, views, aliases and qualifiers", () => {
    const tableCard = hoverAt("select * from spam.spam_x|ray").cards?.[0]
    expect(tableCard).toMatchObject({
      title: "spam_xray",
      badge: "table",
      location: "spam",
      facts: ["2 columns"],
      rows: [
        { name: "id", type: "bigint unsigned", primary: true },
        { name: "smStatus", type: "enum('SMISHING','NORMAL')", primary: false },
      ],
    })
    expect(hoverAt("select * from spam.xray_v|iew").cards?.[0]?.badge).toBe("view")
    expect(hoverAt("select |o.id from orders o").cards?.[0]?.title).toBe("orders")
    expect(hoverAt("select * from orders |o").cards?.[0]?.title).toBe("orders")
    expect(hoverAt("select * from use|rs").cards?.[0]?.title).toBe("users")
  })

  it("lists a wide table's first columns and counts the rest", () => {
    const card = hoverAt("select * from wi|de").cards?.[0]
    expect(card?.rows).toHaveLength(HOVER_COLUMN_LIMIT)
    expect(card?.more).toBe(3)
    expect(card?.facts).toEqual([`${HOVER_COLUMN_LIMIT + 3} columns`])
  })

  it("describes databases from what is cached, without loading them", () => {
    expect(hoverAt("select * from sp|am.spam_xray").cards).toEqual([
      { title: "spam", badge: "database", facts: ["2 tables"] },
    ])
    const uncached = hoverAt("use sh|op")
    expect(uncached.cards).toEqual([{ title: "shop", badge: "database", facts: [] }])
    expect(uncached.missing).toEqual([])
  })

  it("reports the schema it needs when it isn't loaded", () => {
    const { cards, missing } = hoverAt("select smSt|atus from spam.spam_xray", { app: APP })
    expect(cards).toBeNull()
    expect(missing).toEqual(["spam"])
  })

  it("shows nothing for unknown names and keywords", () => {
    expect(hoverAt("select nop|e from users").cards).toBeNull()
    expect(hoverAt("sel|ect 1").cards).toBeNull()
  })
})
