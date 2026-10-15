import { formatBytes } from "../../lib/cellFormat"
import type { IndexInfo, SchemaColumn, TableDetails } from "../../lib/mysql"

/**
 * The column's key role, as in information_schema COLUMN_KEY: `PRI` for primary key columns,
 * `UNI` for the column of a single-column unique index, `MUL` for the first column of any other
 * index. Empty when none applies.
 */
export function columnKey(column: SchemaColumn, indexes: readonly IndexInfo[]): string {
  if (column.isPrimary) return "PRI"
  const leading = indexes.filter((index) => index.columns[0] === column.name)
  if (leading.some((index) => index.unique && index.columns.length === 1)) return "UNI"
  return leading.length > 0 ? "MUL" : ""
}

export function columnExtra(column: SchemaColumn): string {
  return column.isAutoIncrement ? "auto_increment" : ""
}

export interface TableFact {
  label: string
  value: string
  title?: string
}

/** Summary line under the title; facts the server didn't report are left out. */
export function tableFacts(details: TableDetails): TableFact[] {
  const facts: TableFact[] = [{ label: "Kind", value: details.kind === "view" ? "View" : "Table" }]
  if (details.engine) facts.push({ label: "Engine", value: details.engine })
  if (details.rowEstimate !== null) {
    facts.push({
      label: "Rows",
      value: `≈ ${details.rowEstimate.toLocaleString()}`,
      title: "Estimate from information_schema",
    })
  }
  if (details.dataLength !== null) {
    facts.push({ label: "Size", value: formatBytes(details.dataLength) })
  }
  if (details.collation) facts.push({ label: "Collation", value: details.collation })
  return facts
}
