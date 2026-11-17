import { describe, expect, it } from "vitest"
import type { ExecResult, QueryResponseItem } from "./mysql"
import {
  mayDelete,
  splitBackupStop,
  statementPreview,
  trashedNote,
  unsupportedDeletes,
} from "./sqlTrash"

const exec = (extra: Partial<ExecResult> = {}): ExecResult => ({
  kind: "exec",
  affectedRows: 1,
  lastInsertId: null,
  elapsedMs: 1,
  reconnected: false,
  statement: "DELETE FROM t",
  ...extra,
})

describe("splitBackupStop", () => {
  it("separates the stop from the results", () => {
    const stop = {
      kind: "backup_stopped",
      statementIndex: 1,
      reason: "too many rows",
      statement: "DELETE FROM big",
      elapsedMs: 0,
      resumeToken: null,
    } as const
    const items: QueryResponseItem[] = [exec(), stop]
    expect(splitBackupStop(items)).toEqual({ results: [exec()], stop })
    expect(splitBackupStop([exec()])).toEqual({ results: [exec()], stop: null })
  })
})

describe("mayDelete / unsupportedDeletes", () => {
  it("only asks the backend about text that mentions DELETE", () => {
    expect(mayDelete("delete from t")).toBe(true)
    expect(mayDelete("SELECT 1;\nDELETE FROM t")).toBe(true)
    expect(mayDelete("SELECT deleted_at FROM t")).toBe(false)
    expect(mayDelete("SELECT 1")).toBe(false)
  })

  it("keeps the unsupported entries", () => {
    const plan = [
      { index: 0, backup: "ok", reason: null, statement: "DELETE FROM t" },
      { index: 2, backup: "unsupported", reason: "join", statement: "DELETE t FROM t JOIN u" },
    ] as const
    expect(unsupportedDeletes(plan)).toEqual([plan[1]])
  })
})

describe("statementPreview / trashedNote", () => {
  it("shows one short line", () => {
    expect(statementPreview("DELETE  FROM t\n  WHERE id = 1")).toBe("DELETE FROM t WHERE id = 1")
    expect(statementPreview("x".repeat(10), 5)).toBe("xxxx…")
  })

  it("names the rows moved to the trash", () => {
    expect(trashedNote(exec({ trashedRows: 3 }))).toBe("3 rows moved to Trash")
    expect(trashedNote(exec({ trashedRows: 0 }))).toBeNull()
    expect(trashedNote(exec())).toBeNull()
  })
})
