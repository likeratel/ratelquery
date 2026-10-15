import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete"
import { MySQL, sql } from "@codemirror/lang-sql"
import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import type { SchemaSnapshot, SchemaTable } from "../../../lib/mysql"
import type { SchemaCatalog } from "./catalog"
import { keywordSource, schemaCompletionSource, type CompletionEnv } from "./source"

const column = (name: string, typeName: string) => ({
  name,
  typeName,
  nullable: false,
  isPrimary: false,
  isAutoIncrement: false,
  defaultValue: null,
})

const table = (name: string, columns: [string, string][], kind: "table" | "view" = "table") =>
  ({ name, kind, columns: columns.map(([n, t]) => column(n, t)) }) satisfies SchemaTable

const snapshot = (database: string, tables: SchemaTable[]): SchemaSnapshot => ({
  database,
  tables,
  fetchedAt: "2026-10-01T00:00:00Z",
})

const SPAM = snapshot("spam", [
  table("spam_bayes", [
    ["bayesId", "int unsigned"],
    ["token", "varchar(20)"],
  ]),
  table("spam_log", [["id", "bigint"]]),
])

const APP = snapshot("app", [
  table("users", [
    ["id", "int"],
    ["name", "varchar(50)"],
  ]),
  table("orders", [
    ["id", "int"],
    ["user_id", "int"],
  ]),
  table("active_users", [["id", "int"]], "view"),
  table("order", [["id", "int"]]),
  table("my table", [["id", "int"]]),
])

const SHOP = snapshot("shop", [table("products", [["sku", "varchar(20)"]])])

/** Fake env: the catalog can change between calls; schema requests resolve when told to. */
function fakeEnv(schemas: Record<string, SchemaSnapshot> = { app: APP, spam: SPAM }) {
  const requested: string[] = []
  const pending = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  const state = { catalog: { currentDatabase: "app", databases: ["app", "shop", "spam"], schemas } }
  const env: CompletionEnv = {
    catalog: (): SchemaCatalog => state.catalog,
    requestSchema: (database) => {
      requested.push(database)
      const existing = pending.get(database)
      if (existing) return existing.promise
      let resolve = () => {}
      const promise = new Promise<void>((r) => (resolve = r))
      pending.set(database, { promise, resolve })
      return promise
    },
  }
  const load = async (database: string, schema: SchemaSnapshot) => {
    state.catalog = { ...state.catalog, schemas: { ...state.catalog.schemas, [database]: schema } }
    pending.get(database)?.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { env, requested, load }
}

function contextAt(marked: string, explicit = false) {
  const pos = marked.indexOf("|")
  const doc = marked.slice(0, pos) + marked.slice(pos + 1)
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  return new CompletionContext(state, pos, explicit)
}

function complete(env: CompletionEnv, marked: string, explicit = false, onSchemaLoaded = () => {}) {
  const source = schemaCompletionSource(env, { onSchemaLoaded })
  return source(contextAt(marked, explicit)) as CompletionResult | null
}

/** Options in the order the completion list ranks them (boost first, stable otherwise). */
const ranked = (result: CompletionResult | null): Completion[] =>
  [...(result?.options ?? [])].sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0))

const labels = (result: CompletionResult | null) => ranked(result).map((o) => o.label)

describe("schema completion: top-level positions", () => {
  it("puts the statement's columns first, with type and table, in the user's example", () => {
    const { env } = fakeEnv()
    const result = complete(env, "select * from spam.spam_bayes where bay| = 1;")
    expect(result?.from).toBe(36)
    const options = ranked(result)
    expect(options[0]).toMatchObject({
      label: "bayesId",
      detail: "int unsigned · spam_bayes",
      type: "property",
    })
    expect(options.slice(0, 2).map((o) => o.label)).toEqual(["bayesId", "token"])
    expect(options.find((o) => o.label === "token")?.detail).toBe("varchar(20) · spam_bayes")
  })

  it("ranks columns over tables over databases, and lifts an exact match", () => {
    const { env } = fakeEnv()
    const options = ranked(complete(env, "select * from users where u|"))
    const boostOf = (label: string) => options.find((o) => o.label === label)?.boost
    expect(boostOf("name")).toBeGreaterThan(boostOf("users") ?? 0)
    expect(boostOf("users")).toBeGreaterThan(boostOf("app") ?? 0)
    expect(boostOf("app")).toBeGreaterThan(-1)
    const exact = ranked(complete(env, "select * from users where users|"))
    expect(exact[0]?.label).toBe("users")
  })

  it("shows a column shared by two tables once per table", () => {
    const { env } = fakeEnv()
    const ids = ranked(complete(env, "select i| from users u join orders o on o.user_id = u.id"))
      .filter((o) => o.label === "id")
      .map((o) => o.detail)
    expect(ids).toEqual(["int · users", "int · orders"])
  })

  it("offers aliases in expressions", () => {
    const { env } = fakeEnv()
    expect(ranked(complete(env, "select o| from orders o"))).toContainEqual(
      expect.objectContaining({ label: "o", detail: "alias · orders" }),
    )
  })

  it("offers databases, tables and views after FROM, and no columns", () => {
    const { env } = fakeEnv()
    const options = ranked(complete(env, "select * from |", true))
    expect(options.map((o) => [o.label, o.detail])).toEqual([
      ["users", "table"],
      ["orders", "table"],
      ["active_users", "view"],
      ["order", "table"],
      ["my table", "table"],
      ["app", "database"],
      ["shop", "database"],
      ["spam", "database"],
    ])
  })

  it("quotes names that need it", () => {
    const { env } = fakeEnv()
    const options = ranked(complete(env, "select * from |", true))
    expect(options.find((o) => o.label === "order")?.apply).toBe("`order`")
    expect(options.find((o) => o.label === "my table")?.apply).toBe("`my table`")
    expect(options.find((o) => o.label === "users")?.apply).toBeUndefined()
  })

  it("opens on an empty word only when asked (Ctrl+Space)", () => {
    const { env } = fakeEnv()
    expect(complete(env, "select * from users where |")).toBeNull()
    expect(labels(complete(env, "select * from users where |", true))[0]).toBe("id")
  })

  it("stays out of strings, comments and alias positions", () => {
    const { env } = fakeEnv()
    expect(complete(env, "select 'us|' from users", true)).toBeNull()
    expect(complete(env, "select 1 -- us|", true)).toBeNull()
    expect(complete(env, "select * from users u|", true)).toBeNull()
  })
})

describe("schema completion: after a dot", () => {
  it("lists a database's tables", () => {
    const { env } = fakeEnv()
    const result = complete(env, "select * from spam.|")
    expect(labels(result)).toEqual(["spam_bayes", "spam_log"])
    expect(result?.from).toBe(19)
  })

  it("lists the columns of an alias, a FROM table and db.table", () => {
    const { env } = fakeEnv()
    expect(labels(complete(env, "select o.| from orders o"))).toEqual(["id", "user_id"])
    expect(labels(complete(env, "select * from users where users.|"))).toEqual(["id", "name"])
    expect(labels(complete(env, "select spam.spam_bayes.|"))).toEqual(["bayesId", "token"])
    expect(labels(complete(env, "select b.| from spam.spam_bayes b"))).toEqual(["bayesId", "token"])
  })

  it("matches qualifiers ignoring case", () => {
    const { env } = fakeEnv()
    expect(labels(complete(env, "select * from SPAM.|"))).toEqual(["spam_bayes", "spam_log"])
    expect(labels(complete(env, "select B.| from spam.spam_bayes b"))).toEqual(["bayesId", "token"])
  })

  it("handles backtick qualifiers and a backtick word", () => {
    const { env } = fakeEnv()
    const result = complete(env, "select * from `spam`.`|`")
    expect(result).toMatchObject({ from: 21, to: 23 })
    expect(labels(result)).toEqual(["`spam_bayes`", "`spam_log`"])
    expect(ranked(result)[0]?.apply).toBeUndefined()
  })

  it("has nothing for a derived table or an unknown name", () => {
    const { env, requested } = fakeEnv()
    expect(complete(env, "select t.| from (select 1 as x) t")).toBeNull()
    expect(complete(env, "select nope.|")).toBeNull()
    expect(requested).toEqual([])
  })
})

describe("schema completion: loading other databases", () => {
  it("requests a missing schema and reopens once it has loaded", async () => {
    const { env, requested, load } = fakeEnv()
    const reopened: number[] = []
    const onLoaded = (_: CompletionContext, from: number) => reopened.push(from)
    const source = schemaCompletionSource(env, { onSchemaLoaded: onLoaded })
    expect(source(contextAt("select * from shop.|"))).toBeNull()
    expect(source(contextAt("select * from shop.p|"))).toBeNull()
    expect(requested).toEqual(["shop", "shop"])
    expect(reopened).toEqual([])

    await load("shop", SHOP)
    // Reopened once, for the latest request.
    expect(reopened).toEqual([19])
    expect(labels(source(contextAt("select * from shop.p|")) as CompletionResult)).toEqual([
      "products",
    ])
  })

  it("loads the schema of a FROM table in another database and still offers the rest", () => {
    const { env, requested } = fakeEnv()
    const result = complete(env, "select s| from shop.products")
    expect(requested).toEqual(["shop"])
    expect(labels(result)).toContain("users")
  })
})

describe("keyword completion", () => {
  const keywords = (marked: string, explicit = false) =>
    (keywordSource()(contextAt(marked, explicit)) as CompletionResult | null)?.options.map(
      (o) => o.label,
    ) ?? null

  it("keeps lang-sql's MySQL keywords, upper-cased", () => {
    expect(keywords("sel|")).toContain("SELECT")
    expect(keywords("select * from t wh|")).toContain("WHERE")
  })

  it("stays out of dot members, strings and comments", () => {
    expect(keywords("select u.wh| from users u")).toBeNull()
    expect(keywords("select 'sel|'")).toBeNull()
    expect(keywords("-- sel|")).toBeNull()
  })
})

describe("performance", () => {
  it("builds the list for hundreds of tables and thousands of columns within 10ms", () => {
    const tables = Array.from({ length: 500 }, (_, t) =>
      table(
        `table_${t}`,
        Array.from({ length: 12 }, (_, c): [string, string] => [`column_${c}`, "int"]),
      ),
    )
    const big = snapshot("big", tables)
    const env: CompletionEnv = {
      catalog: () => ({
        currentDatabase: "big",
        databases: Array.from({ length: 50 }, (_, i) => `db_${i}`),
        schemas: { big },
      }),
      requestSchema: () => null,
    }
    const source = schemaCompletionSource(env)
    const statement =
      "select c| from table_1 a join table_2 b on a.column_1 = b.column_1 join table_3 c on 1"
    source(contextAt(statement)) // warm the per-snapshot memo
    const runs = 20
    const started = performance.now()
    for (let i = 0; i < runs; i += 1) source(contextAt(statement))
    const average = (performance.now() - started) / runs
    expect(ranked(source(contextAt(statement)) as CompletionResult)).toHaveLength(36 + 3 + 500 + 50)
    expect(average).toBeLessThan(10)
  })
})
