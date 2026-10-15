import { useCallback, useEffect, useRef, useState } from "react"
import { initialColumnWidth } from "../../lib/cellFormat"
import { WidthMemory } from "../../lib/columnWidths"
import type { Cell, ColumnInfo } from "../../lib/mysql"

export const MIN_COLUMN_WIDTH = 48

const memory = new WidthMemory()

/** Drops remembered widths of every grid of a closed tab (grid keys start with `${tabId}:`). */
export function forgetTabColumnWidths(tabId: string): void {
  memory.forgetPrefix(`${tabId}:`)
}

/**
 * Column widths seeded from the data, with an immutable resize action. With a `memoryKey`,
 * resized widths survive a remount that shows the same column names.
 */
export function useColumnWidths(
  columns: readonly ColumnInfo[],
  rows: readonly Cell[][],
  memoryKey?: string,
) {
  const [widths, setWidths] = useState<readonly number[]>(() => {
    const remembered = memoryKey
      ? memory.recall(
          memoryKey,
          columns.map((c) => c.name),
        )
      : undefined
    return remembered ?? columns.map((column, index) => initialColumnWidth(column, rows, index))
  })
  const resized = useRef(false)

  useEffect(() => {
    if (memoryKey && resized.current) {
      memory.remember(
        memoryKey,
        columns.map((c) => c.name),
        widths,
      )
    }
  }, [memoryKey, columns, widths])

  const resize = useCallback((index: number, width: number) => {
    resized.current = true
    setWidths((current) =>
      current.map((w, i) => (i === index ? Math.max(MIN_COLUMN_WIDTH, Math.round(width)) : w)),
    )
  }, [])
  return { widths, resize }
}
