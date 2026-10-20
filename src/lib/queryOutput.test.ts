import { describe, expect, it } from "vitest"
import type { ExecResult, RowsResult } from "./mysql"
import {
  appendEntries,
  dropConnection,
  EMPTY_OUTPUT_LOG,
  entriesFromResults,
  entryFromCancel,
  entryFromError,
  entryStatus,
  fitToBudget,
  formatEntryTime,
  keepConnections,
  MAX_OUTPUT_SQL_CHARS,
  normalizeOutputLog,
  outcomeText,
  pruneLog,
  serializeOutputLog,
  sqlInsertion,
  sqlOneLine,
  visibleEntries,
  type EntryContext,
  type OutputEntry,
  type OutputLog,
} from "./queryOutput"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 20, 12)

const ctx = (patch: Partial<EntryContext> = {}): EntryContext => {
  let n = 0
  return { connectionId: "c1", tabId: "t1", at: NOW, newId: () => `id${++n}`, ...patch }
}

const rows = (patch: Partial<RowsResult> = {}): RowsResult => ({
  kind: "rows",
  columns: [],
  rows: [[{ t: "int", v: "1" }]],
  rowCount: 1,
  truncated: false,
  elapsedMs: 4,
  reconnected: false,
  statement: "SELECT 1",
  ...patch,
})

const exec = (patch: Partial<ExecResult> = {}): ExecResult => ({
  kind: "exec",
  affectedRows: 3,
  lastInsertId: null,
  elapsedMs: 9,
  reconnected: false,
  statement: "UPDATE t SET a = 1",
  ...patch,
})

const entry = (id: string, patch: Partial<OutputEntry> = {}): OutputEntry => ({
  id,
  connectionId: "c1",
  tabId: "t1",
  at: NOW,
  sql: `select ${id}`,
  sqlTruncated: false,
  elapsedMs: 1,
  outcome: { kind: "rows", rowCount: 1, truncated: false },
  ...patch,
})

describe("building entries", () => {
  it("makes one entry per statement with its summary and no row data", () => {
    const entries = entriesFromResults(ctx(), [
      rows({ statement: "  SELECT 1\n" }),
      exec({ lastInsertId: "7" }),
    ])
    expect(entries).toEqual([
      {
        id: "id1",
        connectionId: "c1",
        tabId: "t1",
        at: NOW,
        sql: "SELECT 1",
        sqlTruncated: false,
        elapsedMs: 4,
        outcome: { kind: "rows", rowCount: 1, truncated: false },
      },
      {
        id: "id2",
        connectionId: "c1",
        tabId: "t1",
        at: NOW,
        sql: "UPDATE t SET a = 1",
        sqlTruncated: false,
        elapsedMs: 9,
        outcome: { kind: "exec", affectedRows: 3, lastInsertId: "7" },
      },
    ])
    expect(JSON.stringify(entries)).not.toContain('"t":"int"')
  })

  it("logs run errors and cancels with the run's SQL", () => {
    const failed = entryFromError(ctx(), "select nope", { kind: "query", message: "boom" }, 12)
    expect(failed).toMatchObject({
      sql: "select nope",
      elapsedMs: 12,
      outcome: { kind: "error", message: "boom" },
    })
    expect(entryStatus(failed.outcome)).toBe("error")
    const cancelled = entryFromCancel(ctx(), "select 1", null)
    expect(cancelled.outcome).toEqual({ kind: "cancelled" })
    expect(entryStatus(cancelled.outcome)).toBe("cancelled")
    expect(entryStatus({ kind: "rows", rowCount: 0, truncated: false })).toBe("ok")
  })

  it("cuts very long statements and says so", () => {
    const long = "x".repeat(MAX_OUTPUT_SQL_CHARS + 5)
    const [cut] = entriesFromResults(ctx(), [exec({ statement: long })])
    expect(cut.sql).toHaveLength(MAX_OUTPUT_SQL_CHARS)
    expect(cut.sqlTruncated).toBe(true)
  })

  it("never cuts a surrogate pair in half", () => {
    // The emoji's two UTF-16 units straddle the limit.
    const long = `${"x".repeat(MAX_OUTPUT_SQL_CHARS - 1)}\u{1F600}tail`
    const [cut] = entriesFromResults(ctx(), [exec({ statement: long })])
    expect(cut.sql).toBe("x".repeat(MAX_OUTPUT_SQL_CHARS - 1))
    expect(cut.sqlTruncated).toBe(true)
    // A pair that ends exactly at the limit is kept whole.
    const fits = `${"x".repeat(MAX_OUTPUT_SQL_CHARS - 2)}\u{1F600}tail`
    const [whole] = entriesFromResults(ctx(), [exec({ statement: fits })])
    expect(whole.sql).toBe(`${"x".repeat(MAX_OUTPUT_SQL_CHARS - 2)}\u{1F600}`)
  })
})

describe("outcomeText", () => {
  it("summarises each outcome on one line", () => {
    expect(outcomeText({ kind: "rows", rowCount: 1, truncated: false })).toBe("1 row")
    expect(outcomeText({ kind: "rows", rowCount: 1200, truncated: true })).toBe(
      "1,200 rows (more not fetched)",
    )
    expect(outcomeText({ kind: "exec", affectedRows: 0, lastInsertId: null })).toBe(
      "0 rows affected",
    )
    expect(outcomeText({ kind: "exec", affectedRows: 1, lastInsertId: "0" })).toBe("1 row affected")
    expect(outcomeText({ kind: "exec", affectedRows: 2, lastInsertId: "41" })).toBe(
      "2 rows affected · last insert id 41",
    )
    expect(outcomeText({ kind: "error", message: "Unknown table" })).toBe("Error: Unknown table")
    expect(outcomeText({ kind: "cancelled" })).toBe("Cancelled")
  })
})

describe("text helpers", () => {
  it("collapses a statement to one line", () => {
    expect(sqlOneLine("SELECT *\n  FROM t\n\tWHERE a = 1 ")).toBe("SELECT * FROM t WHERE a = 1")
  })

  it("shows the time for today and the date for older entries", () => {
    const now = new Date(2026, 9, 20, 18, 0, 0).getTime()
    expect(formatEntryTime(new Date(2026, 9, 20, 3, 4, 5).getTime(), now)).toBe("03:04:05")
    expect(formatEntryTime(new Date(2026, 8, 1, 13, 7, 9).getTime(), now)).toBe("2026-09-01 13:07")
  })

  it("puts inserted SQL on lines of its own", () => {
    expect(sqlInsertion("", 0, 0, "select 1")).toBe("select 1")
    expect(sqlInsertion("abc", 3, 3, "select 1")).toBe("\nselect 1")
    expect(sqlInsertion("abc\n", 4, 4, "select 1")).toBe("select 1")
    expect(sqlInsertion("abc def", 3, 4, "select 1")).toBe("\nselect 1\n")
    expect(sqlInsertion("x\ny", 2, 2, "select 1")).toBe("select 1\n")
  })
})

describe("appendEntries", () => {
  it("groups by connection, keeps order and never mutates the log", () => {
    const base: OutputLog = { c1: [entry("a")] }
    const next = appendEntries(base, [entry("b"), entry("x", { connectionId: "c2" }), entry("c")])
    expect(next.c1.map((e) => e.id)).toEqual(["a", "b", "c"])
    expect(next.c2.map((e) => e.id)).toEqual(["x"])
    expect(base.c1.map((e) => e.id)).toEqual(["a"])
    expect(appendEntries(base, [])).toBe(base)
  })

  it("drops the oldest past the cap and skips ids already there", () => {
    const base: OutputLog = { c1: [entry("a"), entry("b")] }
    const next = appendEntries(base, [entry("b"), entry("c"), entry("d")], 3)
    expect(next.c1.map((e) => e.id)).toEqual(["b", "c", "d"])
  })
})

describe("pruneLog", () => {
  const log: OutputLog = {
    c1: [entry("old", { at: NOW - 31 * DAY }), entry("edge", { at: NOW - 30 * DAY })],
    c2: [entry("gone", { connectionId: "c2", at: NOW - 40 * DAY })],
  }

  it("drops entries older than the retention and empty connections", () => {
    const pruned = pruneLog(log, 30, NOW)
    expect(Object.keys(pruned)).toEqual(["c1"])
    expect(pruned.c1.map((e) => e.id)).toEqual(["edge"])
  })

  it("keeps the same log when nothing is old and keeps nothing for 0 days", () => {
    expect(pruneLog(log, 365, NOW)).toBe(log)
    expect(pruneLog(log, 0, NOW)).toEqual({})
    expect(pruneLog({ c1: [] }, 30, NOW)).toEqual({})
  })
})

describe("connections", () => {
  const log: OutputLog = { c1: [entry("a")], c2: [entry("b", { connectionId: "c2" })] }

  it("drops a deleted connection", () => {
    expect(dropConnection(log, "c1")).toEqual({ c2: log.c2 })
    expect(dropConnection(log, "c9")).toBe(log)
  })

  it("keeps only the accepted connections", () => {
    expect(keepConnections(log, (id) => id === "c2")).toEqual({ c2: log.c2 })
    expect(keepConnections(log, () => true)).toBe(log)
  })
})

describe("visibleEntries", () => {
  const log: OutputLog = {
    c1: [entry("a"), entry("b", { tabId: "closed" }), entry("c")],
    c2: [entry("z", { connectionId: "c2" })],
  }

  it("lists this tab's entries newest first by default", () => {
    const ids = visibleEntries(log, { connectionId: "c1", tabId: "t1", scope: "tab" })
    expect(ids.map((e) => e.id)).toEqual(["c", "a"])
  })

  it("lists every entry of the connection, closed tabs included", () => {
    const ids = visibleEntries(log, { connectionId: "c1", tabId: "t1", scope: "connection" })
    expect(ids.map((e) => e.id)).toEqual(["c", "b", "a"])
    expect(visibleEntries(log, { connectionId: "c9", tabId: "t1", scope: "connection" })).toEqual(
      [],
    )
  })
})

describe("fitToBudget", () => {
  it("keeps the newest entries across connections that fit", () => {
    const log: OutputLog = {
      c1: [entry("a", { at: 1 }), entry("c", { at: 3 })],
      c2: [entry("b", { connectionId: "c2", at: 2 })],
    }
    expect(fitToBudget(log, 1_000_000)).toBe(log)
    const size = new TextEncoder().encode(JSON.stringify(log.c1[1])).length + 1
    const fitted = fitToBudget(log, size * 2)
    expect(fitted).toEqual({ c1: [log.c1[1]], c2: log.c2 })
  })
})

describe("normalizeOutputLog", () => {
  it("round-trips a serialized log", () => {
    const log: OutputLog = {
      c1: [
        entry("a", { outcome: { kind: "exec", affectedRows: 1, lastInsertId: "3" } }),
        entry("b", { outcome: { kind: "error", message: "x" }, elapsedMs: null }),
        entry("c", { outcome: { kind: "cancelled" } }),
      ],
    }
    expect(normalizeOutputLog(JSON.parse(JSON.stringify(serializeOutputLog(log))))).toEqual(log)
  })

  it("treats anything but a version 1 file as empty", () => {
    for (const raw of [null, "x", [], { version: 2, connections: {} }, { version: 1 }]) {
      expect(normalizeOutputLog(raw)).toEqual(EMPTY_OUTPUT_LOG)
    }
  })

  it("drops broken, misplaced and repeated entries and restores time order", () => {
    const raw = {
      version: 1,
      connections: {
        c1: [
          entry("late", { at: 5 }),
          { ...entry("bad"), outcome: { kind: "rows" } },
          entry("other", { connectionId: "c2" }),
          entry("early", { at: 1 }),
          entry("late", { at: 9 }),
          "junk",
        ],
        c2: "not a list",
        c3: [],
      },
    }
    const log = normalizeOutputLog(raw)
    expect(Object.keys(log)).toEqual(["c1"])
    expect(log.c1.map((e) => `${e.id}@${e.at}`)).toEqual(["early@1", "late@5"])
  })
})
