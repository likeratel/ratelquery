import { beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type QuerySettings } from "../../lib/settings"
import {
  addedLimitFor,
  answerDangerousRun,
  confirmDangerousRun,
  planRun,
  useRunGuardStore,
} from "./runGuard"

const settings = (patch: Partial<QuerySettings> = {}): QuerySettings => ({
  ...DEFAULT_SETTINGS.query,
  ...patch,
})

beforeEach(() => useRunGuardStore.setState({ limitedByTab: {}, confirm: null }))

describe("planRun", () => {
  it("adds the default LIMIT to each unbounded SELECT and reports them as executed", () => {
    const plan = planRun("SELECT * FROM a;\nSELECT * FROM b LIMIT 5;\nSELECT 1", settings())
    expect(plan.changed).toBe(true)
    expect(plan.sql).toBe(
      "SELECT * FROM a LIMIT 1000;\nSELECT * FROM b LIMIT 5;\nSELECT 1 LIMIT 1000",
    )
    expect(plan.limited).toEqual([
      { statement: "SELECT * FROM a LIMIT 1000", limit: 1000 },
      { statement: "SELECT 1 LIMIT 1000", limit: 1000 },
    ])
  })

  it("sends the original text when nothing needs a LIMIT or the option is off", () => {
    const sql = "  SELECT * FROM a LIMIT 3; -- done"
    expect(planRun(sql, settings())).toMatchObject({ sql, changed: false, limited: [] })
    const off = planRun("SELECT * FROM a", settings({ addLimitToSelect: false }))
    expect(off).toMatchObject({ sql: "SELECT * FROM a", changed: false })
  })

  it("lists destructive statements only when confirmation is on", () => {
    const sql = "DELETE FROM t;\nUPDATE t SET a = 1 WHERE id = 2;\nDROP TABLE u"
    expect(planRun(sql, settings()).dangers.map((d) => d.statement)).toEqual([
      "DELETE FROM t",
      "DROP TABLE u",
    ])
    expect(planRun(sql, settings({ confirmDestructive: false })).dangers).toEqual([])
  })
})

describe("confirmDangerousRun", () => {
  it("resolves with the user's answer and closes", async () => {
    const answer = confirmDangerousRun([{ statement: "DROP TABLE t", reason: "x" }])
    expect(useRunGuardStore.getState().confirm?.dangers).toHaveLength(1)
    answerDangerousRun(true)
    await expect(answer).resolves.toBe(true)
    expect(useRunGuardStore.getState().confirm).toBeNull()
  })

  it("cancels an older request when a new one opens", async () => {
    const first = confirmDangerousRun([{ statement: "DROP TABLE a", reason: "x" }])
    const second = confirmDangerousRun([{ statement: "DROP TABLE b", reason: "x" }])
    await expect(first).resolves.toBe(false)
    answerDangerousRun(false)
    await expect(second).resolves.toBe(false)
  })
})

describe("addedLimitFor", () => {
  it("finds the LIMIT added to an executed statement", () => {
    const limited = [{ statement: "SELECT 1 LIMIT 50", limit: 50 }]
    expect(addedLimitFor(limited, "SELECT 1 LIMIT 50")).toBe(50)
    expect(addedLimitFor(limited, "SELECT 1")).toBeNull()
    expect(addedLimitFor(undefined, "SELECT 1")).toBeNull()
  })
})
