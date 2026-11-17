import { describe, expect, it } from "vitest"
import {
  applyFailedTitle,
  appliedMessage,
  canConfirmApply,
  countChanges,
  describeCounts,
  needsApplyConfirm,
  previewSlice,
  previewWarningNote,
  staleApplyMessage,
  trashNote,
} from "./applyPlan"
import type { RowChange } from "./mysql"

const key = { id: { t: "int", v: "1" } } as const
const update: RowChange = { type: "update", key, set: { name: { t: "str", v: "x" } } }
const remove: RowChange = { type: "delete", key }
const insert: RowChange = { type: "insert", values: {} }

describe("countChanges / needsApplyConfirm", () => {
  it("counts each kind and asks only when existing rows change", () => {
    const counts = countChanges([remove, update, update, insert])
    expect(counts).toEqual({ updates: 2, deletes: 1, inserts: 1 })
    expect(needsApplyConfirm(counts)).toBe(true)
    expect(needsApplyConfirm(countChanges([remove]))).toBe(true)
    expect(needsApplyConfirm(countChanges([update]))).toBe(true)
    expect(needsApplyConfirm(countChanges([insert, insert]))).toBe(false)
    expect(needsApplyConfirm(countChanges([]))).toBe(false)
  })
})

describe("describeCounts", () => {
  it("lists only the kinds present, singular or plural", () => {
    expect(describeCounts({ updates: 2, deletes: 1, inserts: 0 })).toBe("2 updates · 1 delete")
    expect(describeCounts({ updates: 0, deletes: 0, inserts: 1200 })).toBe("1,200 inserts")
  })
})

describe("trashNote", () => {
  it("names the rows and the retention", () => {
    expect(trashNote(1, 30)).toBe(
      "1 row will be kept in Trash for 30 days (Settings › Queries › Empty trash after).",
    )
    expect(trashNote(3, 1)).toBe(
      "3 rows will be kept in Trash for 1 day (Settings › Queries › Empty trash after).",
    )
  })
})

describe("previewSlice", () => {
  it("keeps the first statements and counts the rest", () => {
    expect(previewSlice(["a", "b"], 5)).toEqual({ shown: ["a", "b"], hidden: 0 })
    expect(previewSlice(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], hidden: 1 })
  })
})

describe("appliedMessage", () => {
  it("says where deleted rows went", () => {
    expect(appliedMessage(1, 0, "kept")).toBe("Applied changes · 1 row affected")
    expect(appliedMessage(3, 2, "kept")).toBe(
      "Applied changes · 3 rows affected · 2 rows moved to Trash",
    )
    expect(appliedMessage(1, 1, "skipped")).toBe(
      "Applied changes · 1 row affected · 1 row deleted without a backup",
    )
  })
})

describe("confirmation guards", () => {
  it("allows Apply once the preview loaded or failed", () => {
    expect(canConfirmApply({ status: "loading" })).toBe(false)
    expect(canConfirmApply({ status: "ready" })).toBe(true)
    expect(canConfirmApply({ status: "error" })).toBe(true)
  })

  it("explains a warning for deletes and why a stale answer did nothing", () => {
    expect(previewWarningNote(0)).toBeNull()
    expect(previewWarningNote(2)).toMatch(/asked whether to delete without a backup/)
    expect(staleApplyMessage("gone")).toMatch(/closed/)
    expect(staleApplyMessage("changed")).toMatch(/edited/)
  })
})

describe("applyFailedTitle", () => {
  it("never claims a rollback the backend didn't report", () => {
    expect(applyFailedTitle("query")).toBe("Couldn't apply the changes")
    expect(applyFailedTitle("connection")).toMatch(/may not have been applied/)
  })
})
