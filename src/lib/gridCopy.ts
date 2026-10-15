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

function quoteField(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
