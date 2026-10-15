import { beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type QuerySettings } from "../../lib/settings"
import { ATHENA_DIALECT } from "../../lib/sqlDialect"
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
      { index: 0, limit: 1000 },
      { index: 2, limit: 1000 },
    ])
  })

  it("keeps the text between statements, including executable comments", () => {
    const sql = [
      "/*!40101 SET NAMES utf8mb4 */;",
      "-- users first",
      "SELECT * FROM users;",
      "/* plain */",
      "/*!40014 SET FOREIGN_KEY_CHECKS=0 */;",
      "SELECT * FROM orders",
    ].join("\n")
    const plan = planRun(sql, settings())
    expect(plan.sql).toBe(
      [
        "/*!40101 SET NAMES utf8mb4 */;",
        "-- users first",
        "SELECT * FROM users LIMIT 1000;",
        "/* plain */",
        "/*!40014 SET FOREIGN_KEY_CHECKS=0 */;",
        "SELECT * FROM orders LIMIT 1000",
      ].join("\n"),
    )
    // Indexes count the executable comments as statements, as the backend does.
    expect(plan.limited.map((l) => l.index)).toEqual([1, 3])
  })

  it("limits a SELECT inside an executable comment and confirms a DELETE inside one", () => {
    expect(planRun("/*!40101 SELECT * FROM t */", settings()).sql).toBe(
      "/*!40101 SELECT * FROM t LIMIT 1000 */",
    )
    const dangers = planRun("SELECT 1;\n/*!50000 DELETE FROM t */", settings()).dangers
    expect(dangers).toEqual([
      { statement: "/*!50000 DELETE FROM t */", reason: expect.stringMatching(/DELETE/) },
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
  it("finds the LIMIT added to the statement behind a result index", () => {
    const limited = [{ index: 1, limit: 50 }]
    expect(addedLimitFor(limited, 1)).toBe(50)
    expect(addedLimitFor(limited, 0)).toBeNull()
    expect(addedLimitFor(undefined, 1)).toBeNull()
  })

  it("matches a result whose statement text carries a leading comment", () => {
    // The backend keeps a leading comment in `RowsResult.statement`; the index still matches.
    const plan = planRun("SELECT 1;\n-- recent\nSELECT * FROM t", settings())
    expect(addedLimitFor(plan.limited, 1)).toBe(1000)
    expect(addedLimitFor(plan.limited, 0)).toBe(1000)
  })
})

describe("planRun on Athena", () => {
  it("asks before statements that write and splits with double-quoted identifiers", () => {
    const sql =
      'SELECT "a;b" FROM t;\nINSERT INTO t SELECT 1;\nSELECT * FROM t FETCH FIRST 5 ROWS ONLY'
    const plan = planRun(sql, settings(), ATHENA_DIALECT)
    expect(plan.dangers).toEqual([
      { statement: "INSERT INTO t SELECT 1", reason: expect.stringMatching(/INSERT/) },
    ])
    expect(plan.limited).toEqual([{ index: 0, limit: settings().defaultLimit }])
    expect(plan.sql).toBe(
      `SELECT "a;b" FROM t LIMIT ${settings().defaultLimit};\nINSERT INTO t SELECT 1;\nSELECT * FROM t FETCH FIRST 5 ROWS ONLY`,
    )
  })
})
