import { describe, expect, it } from "vitest"
import type { TrashSummary } from "./trash"
import {
  filterTrash,
  formatDeletedAt,
  restoreCount,
  restoreDescription,
  restoreFailedTitle,
  restoreOptions,
  restoredMessage,
  statusNote,
  summaryLine,
  trashLabel,
} from "./trashView"

const summary = (extra: Partial<TrashSummary>): TrashSummary => ({
  id: "i",
  status: "committed",
  deletedAt: "2026-01-02T03:04:05.678Z",
  connectionId: "c1",
  connectionName: "Local",
  database: "shop",
  table: "users",
  source: "grid",
  statement: null,
  columns: [],
  primaryKey: ["id"],
  rowCount: 3,
  ...extra,
})

describe("formatDeletedAt", () => {
  it("shows local time and keeps text that isn't a time", () => {
    const shown = formatDeletedAt("2026-01-02T03:04:05.678Z")
    expect(shown).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(new Date(shown.replace(" ", "T")).getTime()).toBe(
      new Date("2026-01-02T03:04:05.000Z").getTime(),
    )
    expect(formatDeletedAt("yesterday")).toBe("yesterday")
  })
})

describe("filterTrash", () => {
  it("matches connection, table, db.table and statement text", () => {
    const list = [
      summary({ id: "a" }),
      summary({ id: "b", connectionName: "Prod", table: "orders" }),
      summary({ id: "c", source: "sql", statement: "DELETE FROM logs WHERE old" }),
    ]
    expect(filterTrash(list, "").map((s) => s.id)).toEqual(["a", "b", "c"])
    expect(filterTrash(list, "prod").map((s) => s.id)).toEqual(["b"])
    expect(filterTrash(list, "SHOP.ORDERS").map((s) => s.id)).toEqual(["b"])
    expect(filterTrash(list, "logs").map((s) => s.id)).toEqual(["c"])
  })
})

describe("labels", () => {
  it("summarizes entries and the sidebar item", () => {
    expect(summaryLine(summary({}))).toBe("3 rows · Grid")
    expect(summaryLine(summary({ rowCount: 1, source: "sql" }))).toBe("1 row · SQL")
    expect(trashLabel(0)).toBe("Trash")
    expect(trashLabel(1234)).toBe("Trash (1,234)")
    expect(statusNote("committed")).toBeNull()
    expect(statusNote("uncertain")).toMatch(/may still be in the table/)
    expect(restoredMessage(2, 0)).toBe("Restored 2 rows")
    expect(restoredMessage(1, 4)).toBe("Restored 1 row · 4 rows left in Trash")
  })
})

describe("restoreOptions", () => {
  const entry = { connectionId: "c1", rows: [[], [], []] }

  it("restores everything by default, to the entry's own connection", () => {
    expect(restoreOptions(entry, null, "c1")).toEqual({})
    expect(restoreOptions(entry, new Set(), "c1")).toBeNull()
    expect(restoreOptions(entry, new Set([7]), "c1")).toBeNull()
    expect(restoreOptions(entry, new Set([0, 1, 2]), "c1")).toEqual({})
    expect(restoreCount(entry, {})).toBe(3)
  })

  it("sends selected rows in order and another connection", () => {
    const options = restoreOptions(entry, new Set([2, 0, 9]), "c2")
    expect(options).toEqual({ rowIndexes: [0, 2], connectionId: "c2" })
    expect(restoreCount(entry, options ?? {})).toBe(2)
  })

  it("titles a failed restore by what may have happened", () => {
    expect(restoreFailedTitle("query", false)).toBe("Nothing was restored")
    expect(restoreFailedTitle("query", true)).toMatch(/some rows may be restored/)
    expect(restoreFailedTitle("connection", false)).toMatch(/may not have finished/)
    expect(restoreFailedTitle("query", null)).toBe("Restore failed")
    expect(restoreDescription("db.t", "MyISAM")).toMatch(/can't undo/)
    expect(restoreDescription("db.t", null)).toMatch(/nothing is restored if any row fails/)
    expect(restoreDescription("db.t", undefined)).toBe("Into db.t.")
  })
})
