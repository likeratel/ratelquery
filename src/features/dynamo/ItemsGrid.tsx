import { useMemo, useState } from "react"
import { ResultGrid } from "../../components/grid/ResultGrid"
import type { KeySchema, Page } from "../../lib/dynamo"
import { columnInfos, itemCells, itemColumns } from "../../lib/dynamoView"
import type { DisplayRow } from "../../lib/gridEdits"
import type { Cell } from "../../lib/mysql"

const MISSING: Cell = { t: "str", v: "" }

interface ItemsGridProps {
  page: Page
  schema: KeySchema | null
  selected: number | null
  /** Changes whenever a new page arrives, so column widths are re-measured. */
  runKey: string
  onSelect: (index: number) => void
}

/** Read-only grid of one page: top-level attributes as columns, keys first. */
export function ItemsGrid({ page, schema, selected, runKey, onSelect }: ItemsGridProps) {
  const [col, setCol] = useState(0)
  const columns = useMemo(() => itemColumns(page.items, schema), [page.items, schema])
  const infos = useMemo(() => columnInfos(columns), [columns])
  const rows = useMemo(
    () =>
      page.items.map((item, index): DisplayRow => ({
        ref: { kind: "existing", index },
        cells: itemCells(item, columns),
        changed: columns.map(() => false),
        deleted: false,
      })),
    [page.items, columns],
  )
  const sourceRows = useMemo(() => rows.map((r) => r.cells.map((c) => c ?? MISSING)), [rows])

  return (
    <ResultGrid
      key={`${runKey}:${infos.length}`}
      columns={infos}
      sourceRows={sourceRows}
      rows={rows}
      editable={false}
      selection={selected !== null ? { row: selected, col: Math.min(col, infos.length - 1) } : null}
      onSelect={(next) => {
        setCol(next.col)
        onSelect(next.row)
      }}
      insertPlaceholder={() => ""}
    />
  )
}
