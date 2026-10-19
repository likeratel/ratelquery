import { cellToEditText } from "./cellEdit"
import type { Cell } from "./mysql"

/**
 * Clipboard text for grid cells. One cell copies as its plain text (NULL as `NULL`, the same
 * text the cell editor shows). Several cells are tab separated; a value containing a tab, line
 * break or double quote is quoted the way spreadsheets expect, so pasting keeps the columns.
 * Unset cells of inserted rows copy as empty text.
 */
export function copyText(cells: readonly (Cell | undefined)[]): string {
  const texts = cells.map((cell) => (cell ? cellToEditText(cell) : ""))
  if (texts.length === 1) return texts[0]
  return texts.map(quoteField).join("\t")
}

export interface CopyRowsOptions {
  /** Column names, copied as the first line. */
  header?: readonly string[]
}

/**
 * Clipboard text for whole rows: one line per row, cells tab separated and quoted like
 * `copyText`, so a one-column row still pastes as one field. Lines are joined with `\n`.
 */
export function copyRowsText(
  rows: readonly (readonly (Cell | undefined)[])[],
  options: CopyRowsOptions = {},
): string {
  const lines = rows.map((cells) =>
    cells.map((cell) => quoteField(cell ? cellToEditText(cell) : "")).join("\t"),
  )
  const header = options.header ? [options.header.map(quoteField).join("\t")] : []
  return [...header, ...lines].join("\n")
}

/** What a grid copy action takes: the target rows, the same with column names, or one cell. */
export type GridCopyKind = "rows" | "rows-with-names" | "cell"

export interface GridCopySource {
  rows: readonly { cells: readonly (Cell | undefined)[] }[]
  columnNames: readonly string[]
  /** Display indexes of the rows to copy, in display order. */
  targetRows: readonly number[]
  /** The cell `"cell"` copies. */
  cell: { row: number; col: number } | null
}

/** Clipboard text for a grid copy action, or null when there is nothing to copy. */
export function gridCopyText(kind: GridCopyKind, source: GridCopySource): string | null {
  if (kind === "cell") {
    const row = source.cell ? source.rows[source.cell.row] : undefined
    if (!source.cell || !row) return null
    return copyText([row.cells[source.cell.col]])
  }
  const rows = source.targetRows.flatMap((index) => {
    const row = source.rows[index]
    return row ? [row.cells] : []
  })
  if (rows.length === 0) return null
  return copyRowsText(rows, kind === "rows-with-names" ? { header: source.columnNames } : {})
}

function quoteField(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
