import { describe, expect, it } from "vitest"
import { runScopeText } from "./runScope"
import { MYSQL_SYNTAX } from "./sqlContext"

const sql = "select 1;\nselect 2;\n"

describe("runScopeText", () => {
  it("runs the statement at the cursor on the statement scope", () => {
    expect(runScopeText("statement", { sql, cursor: 12 }, MYSQL_SYNTAX)).toEqual({
      sql: "select 2;",
      source: "statement",
    })
  })

  it("uses the end of the text when the cursor is unknown", () => {
    expect(runScopeText("statement", { sql }, MYSQL_SYNTAX)?.sql).toBe("select 2;")
  })

  it("has nothing to run for an empty editor", () => {
    expect(runScopeText("statement", { sql: "  \n" }, MYSQL_SYNTAX)).toBeNull()
  })

  it("runs the selected text on the selection scope", () => {
    expect(runScopeText("selection", { sql, selectedText: "select 2" }, MYSQL_SYNTAX)).toEqual({
      sql: "select 2",
      source: "selection",
    })
  })

  it("falls back to the whole editor without a selection", () => {
    for (const selectedText of [undefined, "", "  \n"]) {
      expect(runScopeText("selection", { sql, selectedText }, MYSQL_SYNTAX)).toEqual({
        sql: null,
        source: "all",
      })
    }
  })
})
