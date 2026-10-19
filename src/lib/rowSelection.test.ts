import { describe, expect, it } from "vitest"
import {
  clearSelection,
  clickRow,
  copyTargetRows,
  EMPTY_ROW_SELECTION,
  extendTo,
  isAllSelected,
  retainRows,
  selectAll,
  selectedRows,
  selectOnly,
  toggleRow,
} from "./rowSelection"

describe("row selection", () => {
  it("selects one row and makes it the anchor", () => {
    const selection = selectOnly(3)
    expect(selectedRows(selection)).toEqual([3])
    expect(selection.anchor).toBe(3)
  })

  it("toggles a row without touching the others or the original", () => {
    const start = selectOnly(1)
    const added = toggleRow(start, 4)
    expect(selectedRows(added)).toEqual([1, 4])
    expect(added.anchor).toBe(4)
    expect(selectedRows(start)).toEqual([1])
    const removed = toggleRow(added, 1)
    expect(selectedRows(removed)).toEqual([4])
  })

  it("extends from the anchor in either direction and keeps the anchor", () => {
    const down = extendTo(selectOnly(2), 5)
    expect(selectedRows(down)).toEqual([2, 3, 4, 5])
    expect(down.anchor).toBe(2)
    const up = extendTo(down, 0)
    expect(selectedRows(up)).toEqual([0, 1, 2])
  })

  it("extends without an anchor by selecting only that row", () => {
    expect(selectedRows(extendTo(EMPTY_ROW_SELECTION, 3))).toEqual([3])
  })

  it("selects all rows and tells when all are selected", () => {
    const all = selectAll(3)
    expect(selectedRows(all)).toEqual([0, 1, 2])
    expect(isAllSelected(all, 3)).toBe(true)
    expect(isAllSelected(all, 4)).toBe(false)
    expect(isAllSelected(selectAll(0), 0)).toBe(false)
    expect(isAllSelected(clearSelection(), 2)).toBe(false)
  })

  it("applies click modifiers, Shift first", () => {
    const start = selectOnly(1)
    expect(selectedRows(clickRow(start, 3, { toggle: false, extend: false }))).toEqual([3])
    expect(selectedRows(clickRow(start, 3, { toggle: true, extend: false }))).toEqual([1, 3])
    expect(selectedRows(clickRow(start, 3, { toggle: true, extend: true }))).toEqual([1, 2, 3])
  })

  it("drops rows past the row count and keeps the value when nothing changes", () => {
    const selection = toggleRow(selectOnly(1), 5)
    expect(retainRows(selection, 6)).toBe(selection)
    const trimmed = retainRows(selection, 5)
    expect(selectedRows(trimmed)).toEqual([1])
    expect(trimmed.anchor).toBeNull()
    expect(retainRows(selectOnly(2), 5).anchor).toBe(2)
  })

  it("copies the selection in display order, or the focused row", () => {
    expect(copyTargetRows(toggleRow(selectOnly(4), 0), 2)).toEqual([0, 4])
    expect(copyTargetRows(EMPTY_ROW_SELECTION, 2)).toEqual([2])
    expect(copyTargetRows(EMPTY_ROW_SELECTION, null)).toEqual([])
  })
})
