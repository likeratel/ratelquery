import { useCallback, useState } from "react"
import { initialColumnWidth } from "../../lib/cellFormat"
import type { Cell, ColumnInfo } from "../../lib/mysql"

export const MIN_COLUMN_WIDTH = 48

/** Column widths seeded from the data, with an immutable resize action. */
export function useColumnWidths(columns: readonly ColumnInfo[], rows: readonly Cell[][]) {
  const [widths, setWidths] = useState<readonly number[]>(() =>
    columns.map((column, index) => initialColumnWidth(column, rows, index)),
  )
  const resize = useCallback((index: number, width: number) => {
    setWidths((current) =>
      current.map((w, i) => (i === index ? Math.max(MIN_COLUMN_WIDTH, Math.round(width)) : w)),
    )
  }, [])
  return { widths, resize }
}
