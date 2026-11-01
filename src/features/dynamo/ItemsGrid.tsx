import { useCallback, useMemo, useState } from "react"
import { ResultGrid, type GridSelection } from "../../components/grid/ResultGrid"
import type { KeySchema, Page } from "../../lib/dynamo"
import {
  changesUnder,
  inlineEditType,
  itemEdit,
  withPendingValues,
  type DynamoEdits,
} from "../../lib/dynamoEdits"
import { columnInfos, itemCells, itemColumns } from "../../lib/dynamoView"
import type { DisplayRow } from "../../lib/gridEdits"
import type { Cell } from "../../lib/mysql"

const MISSING: Cell = { t: "str", v: "" }
const EMPTY_PLACEHOLDER = () => ""
const EDITOR_HINT =
  "Strings are saved as typed. Numbers must be valid; booleans take true or false."

interface ItemsGridProps {
  page: Page
  schema: KeySchema | null
  selected: number | null
  /** Changes whenever a new page arrives, so column widths are re-measured. */
  runKey: string
  /** Pending inline edits; their values are shown in place and marked as changed. */
  edits: DynamoEdits
  /** False while edits are being applied or the key schema is unknown. */
  editable: boolean
  onSelect: (index: number) => void
  /** Stages a typed value; returns an error message to keep the cell editor open. */
  onCommit: (index: number, attribute: string, text: string) => string | null
  /** Double-click or Enter on a cell that only the JSON item editor can change. */
  onOpenEditor: (index: number) => void
}

/**
 * Grid of one page: top-level attributes as columns, keys first. Scalar attributes (S, N, BOOL,
 * missing) are edited in place; the rest open the item editor.
 */
export function ItemsGrid(props: ItemsGridProps) {
  const { page, schema, selected, runKey, edits, editable, onSelect, onCommit, onOpenEditor } =
    props
  const [col, setCol] = useState(0)
  const columns = useMemo(() => itemColumns(page.items, schema), [page.items, schema])
  const infos = useMemo(() => columnInfos(columns), [columns])
  const rows = useMemo(
    () =>
      page.items.map((item, index): DisplayRow => {
        const edit = itemEdit(edits, item, schema)
        return {
          ref: { kind: "existing", index },
          cells: itemCells(withPendingValues(item, edit), columns),
          changed: columns.map((column) => changesUnder(edit, [column.name]).length > 0),
          deleted: false,
        }
      }),
    [page.items, columns, edits, schema],
  )
  // Seeds column widths from the loaded values, so staging an edit doesn't re-measure.
  const sourceRows = useMemo(
    () => page.items.map((item) => itemCells(item, columns).map((c) => c ?? MISSING)),
    [page.items, columns],
  )
  const select = useCallback(
    (next: GridSelection) => {
      setCol(next.col)
      onSelect(next.row)
    },
    [onSelect],
  )
  const canEditCell = useCallback(
    ({ row, col }: GridSelection) => {
      const column = columns[col]
      const item = page.items[row]
      return Boolean(column && item) && inlineEditType(item[column.name], column.key) !== null
    },
    [columns, page.items],
  )
  const openEditor = useCallback(({ row }: GridSelection) => onOpenEditor(row), [onOpenEditor])
  const commit = useCallback(
    (row: DisplayRow, col: number, text: string) =>
      row.ref.kind === "existing"
        ? onCommit(row.ref.index, columns[col].name, text)
        : "New items are added with New item",
    [onCommit, columns],
  )

  return (
    <ResultGrid
      key={`${runKey}:${infos.length}`}
      columns={infos}
      sourceRows={sourceRows}
      rows={rows}
      editable={editable}
      selection={selected !== null ? { row: selected, col: Math.min(col, infos.length - 1) } : null}
      onSelect={select}
      onCommit={editable ? commit : undefined}
      canEditCell={canEditCell}
      onEditUnavailable={openEditor}
      editorHint={EDITOR_HINT}
      insertPlaceholder={EMPTY_PLACEHOLDER}
    />
  )
}
