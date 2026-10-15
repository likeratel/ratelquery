import { describe, expect, it } from "vitest"
import { ANSI_SYNTAX } from "./sqlContext"
import { analyzeStatement, cursorContext, type CursorContext } from "./sqlScope"

/** Context at the `|` marker. */
function at(marked: string, whole = false): CursorContext {
  const pos = marked.indexOf("|")
  const sql = marked.slice(0, pos) + marked.slice(pos + 1)
  return whole ? cursorContext(sql, pos) : analyzeStatement(sql, pos)
}

const kindAt = (marked: string) => at(marked).kind

function tablesAt(marked: string) {
  const context = at(marked)
  return context.kind === "none" ? null : context.tables
}

describe("table references", () => {
  it("reads db-qualified tables, as in the user's example", () => {
    expect(tablesAt("select * from spam.spam_bayes where bayesId = 1|;")).toEqual([
      { database: "spam", table: "spam_bayes", alias: null },
    ])
  })

  it("reads aliases with and without AS, joins and comma joins", () => {
    expect(
      tablesAt("select | from users AS u join app.orders o on o.user_id = u.id, items i, tags"),
    ).toEqual([
      { database: null, table: "users", alias: "u" },
      { database: "app", table: "orders", alias: "o" },
      { database: null, table: "items", alias: "i" },
      { database: null, table: "tags", alias: null },
    ])
  })

  it("never takes a keyword for an alias", () => {
    const refs = tablesAt(
      "select | from a left join b on a.id = b.id inner join c using (id) natural join d where 1",
    )
    expect(refs).toEqual([
      { database: null, table: "a", alias: null },
      { database: null, table: "b", alias: null },
      { database: null, table: "c", alias: null },
      { database: null, table: "d", alias: null },
    ])
    expect(tablesAt("select | from t group by x")).toEqual([
      { database: null, table: "t", alias: null },
    ])
    expect(tablesAt("select | from t order by x limit 1")).toEqual([
      { database: null, table: "t", alias: null },
    ])
  })

  it("reads backtick identifiers", () => {
    expect(tablesAt("select | from `my db`.`odd table` as `x y`")).toEqual([
      { database: "my db", table: "odd table", alias: "x y" },
    ])
  })

  it("treats a derived table as an alias with unknown columns", () => {
    expect(
      tablesAt("select t.| from (select id from users) t join orders o on o.id = t.id"),
    ).toEqual([
      { database: null, table: null, alias: "t" },
      { database: null, table: "orders", alias: "o" },
    ])
  })

  it("lists the subquery's tables before the outer query's", () => {
    expect(tablesAt("select * from t where id in (select | from u)")).toEqual([
      { database: null, table: "u", alias: null },
      { database: null, table: "t", alias: null },
    ])
  })

  it("reads UPDATE, INSERT INTO and DELETE FROM targets", () => {
    expect(tablesAt("update app.users u set u.| = 1")).toEqual([
      { database: "app", table: "users", alias: "u" },
    ])
    expect(tablesAt("insert into users (|) values (1)")).toEqual([
      { database: null, table: "users", alias: null },
    ])
    expect(tablesAt("delete from users where |")).toEqual([
      { database: null, table: "users", alias: null },
    ])
  })

  it("only looks at the statement under the cursor", () => {
    const context = at("select * from a;\nselect | from b;", true)
    expect(context.kind !== "none" && context.tables).toEqual([
      { database: null, table: "b", alias: null },
    ])
  })
})

describe("qualifier chains", () => {
  it("reads `x.` and `db.table.` before the cursor", () => {
    expect(at("select * from t where spam.|")).toMatchObject({ kind: "member", parents: ["spam"] })
    expect(at("select spam.spam_bayes.bay|")).toMatchObject({
      kind: "member",
      parents: ["spam", "spam_bayes"],
      word: { from: 23, to: 26, text: "bay", quoted: false },
    })
  })

  it("reads backtick qualifiers and a backtick word with its closing quote", () => {
    // closeBrackets inserts the closing backtick, so the cursor sits between the two.
    expect(at("select * from `spam`.`sp|`")).toMatchObject({
      kind: "member",
      parents: ["spam"],
      word: { from: 21, to: 25, text: "sp", quoted: true },
    })
    expect(at("select * from `spam`.`|")).toMatchObject({
      kind: "member",
      parents: ["spam"],
      word: { from: 21, to: 22, text: "", quoted: true },
    })
  })
})

describe("cursor position", () => {
  it("expects columns in expression clauses", () => {
    expect(kindAt("select |")).toBe("column")
    expect(kindAt("select a, |")).toBe("column")
    expect(kindAt("select a from t where |")).toBe("column")
    expect(kindAt("select a from t where a = 1 and b|")).toBe("column")
    expect(kindAt("select a from t where a = |")).toBe("column")
    expect(kindAt("select a from t join u on |")).toBe("column")
    expect(kindAt("select a from t order by |")).toBe("column")
    expect(kindAt("select a from t group by a, |")).toBe("column")
    expect(kindAt("select a from t having |")).toBe("column")
    expect(kindAt("update t set |")).toBe("column")
  })

  it("expects columns inside function calls and lists", () => {
    expect(kindAt("select count(|) from t")).toBe("column")
    expect(kindAt("select concat(a, |) from t")).toBe("column")
    expect(kindAt("select a from t where id in (1, |)")).toBe("column")
    expect(kindAt("insert into t (a, |) values (1)")).toBe("column")
  })

  it("expects tables after FROM, JOIN and commas in the table list", () => {
    expect(kindAt("select * from |")).toBe("table")
    expect(kindAt("select * from sp|")).toBe("table")
    expect(kindAt("select * from a, |")).toBe("table")
    expect(kindAt("select * from a join |")).toBe("table")
    expect(kindAt("insert into |")).toBe("table")
    expect(kindAt("update |")).toBe("table")
    expect(kindAt("use |")).toBe("database")
  })

  it("expects only keywords where a name would be an alias or an operator", () => {
    expect(kindAt("|")).toBe("keyword")
    expect(kindAt("sel|")).toBe("keyword")
    expect(kindAt("select * |")).toBe("keyword")
    expect(kindAt("select a |")).toBe("keyword")
    expect(kindAt("select * from t |")).toBe("keyword")
    expect(kindAt("select * from t where a |")).toBe("keyword")
    expect(kindAt("select * from t limit |")).toBe("keyword")
    expect(kindAt("select count(*) |")).toBe("keyword")
  })

  it("offers nothing inside strings and comments", () => {
    expect(kindAt("select 'ab|c'")).toBe("none")
    expect(kindAt("select 'abc|")).toBe("none")
    expect(kindAt("select 1 -- note|")).toBe("none")
    expect(kindAt("select /* a| */ 1")).toBe("none")
    expect(at("select 1;\n-- note|", true).kind).toBe("none")
  })

  it("starts over after a statement's semicolon", () => {
    expect(at("select * from t; |", true).kind).toBe("keyword")
  })

  it("shifts word offsets to document offsets", () => {
    expect(at("select 1;\nselect * from t where bay|", true)).toMatchObject({
      kind: "column",
      word: { from: 32, to: 35, text: "bay" },
    })
  })
})

describe("ANSI quotes (Athena)", () => {
  const ansiAt = (marked: string): CursorContext => {
    const pos = marked.indexOf("|")
    return cursorContext(marked.slice(0, pos) + marked.slice(pos + 1), pos, ANSI_SYNTAX)
  }

  it("reads double-quoted tables, as the tree's SELECT writes them", () => {
    expect(ansiAt('SELECT | FROM "sales"."orders" LIMIT 1000')).toEqual({
      kind: "column",
      word: { from: 7, to: 7, text: "", quoted: false },
      tables: [{ database: "sales", table: "orders", alias: null }],
    })
    expect(ansiAt('SELECT o.| FROM "sales"."my ""t""" o')).toMatchObject({
      kind: "member",
      parents: ["o"],
      tables: [{ database: "sales", table: 'my "t"', alias: "o" }],
    })
  })

  it("completes inside a double-quoted word, unescaping doubled quotes", () => {
    expect(ansiAt('SELECT "a""b|" FROM t')).toMatchObject({
      kind: "column",
      word: { from: 7, to: 13, text: 'a"b', quoted: true },
    })
    expect(ansiAt('SELECT * FROM "sales".|')).toMatchObject({ kind: "member", parents: ["sales"] })
  })

  it("still treats single quotes as strings", () => {
    expect(ansiAt("SELECT 'a|'").kind).toBe("none")
  })

  it("reads double quotes as strings in MySQL", () => {
    expect(at('SELECT | FROM "sales"."orders"', true)).toMatchObject({ kind: "column", tables: [] })
    expect(at('SELECT "a|" FROM t').kind).toBe("none")
  })
})
