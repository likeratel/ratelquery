import { describe, expect, it } from "vitest"
import { databasesWhileRunning, lastUseTarget, useTarget } from "./sqlUse"

describe("useTarget", () => {
  it("reads the database of a USE statement in any case", () => {
    expect(useTarget("use user")).toBe("user")
    expect(useTarget("USE Shop;")).toBe("Shop")
    expect(useTarget("  Use\n  sample ;  ")).toBe("sample")
  })

  it("unquotes a backtick identifier", () => {
    expect(useTarget("USE `my-db`")).toBe("my-db")
    expect(useTarget("USE `we``ird`;")).toBe("we`ird")
    expect(useTarget("use `한글`")).toBe("한글")
  })

  it("skips comments around the statement", () => {
    expect(useTarget("-- switch first\nUSE app /* main */;")).toBe("app")
    expect(useTarget("/* a */ use # trailing\n reports")).toBe("reports")
  })

  it("ignores statements that are not a complete USE", () => {
    expect(useTarget("select * from users")).toBeNull()
    expect(useTarget("user_table")).toBeNull()
    expect(useTarget("use")).toBeNull()
    expect(useTarget("use ;")).toBeNull()
    expect(useTarget("USE `unterminated")).toBeNull()
    expect(useTarget("USE ``")).toBeNull()
    expect(useTarget("USE a b")).toBeNull()
    expect(useTarget("USE 'quoted string'")).toBeNull()
    expect(useTarget("-- use app")).toBeNull()
  })
})

describe("lastUseTarget", () => {
  it("returns the last database switched to", () => {
    expect(lastUseTarget(["use a", "select 1", "USE `b`", "show tables"])).toBe("b")
  })

  it("is null when no statement switches", () => {
    expect(lastUseTarget([])).toBeNull()
    expect(lastUseTarget(["select 1", "show tables"])).toBeNull()
  })
})

describe("databasesWhileRunning", () => {
  it("gives each statement the database in effect when it ran", () => {
    expect(
      databasesWhileRunning(["select 1", "use b", "select 2", "USE c", "select 3"], "a"),
    ).toEqual(["a", "a", "b", "b", "c"])
  })

  it("starts from no database and stays there without a USE", () => {
    expect(databasesWhileRunning(["select 1", "show tables"], null)).toEqual([null, null])
    expect(databasesWhileRunning([], "a")).toEqual([])
  })
})
