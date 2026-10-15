import { cellsEqual } from "./cellEdit"
import { inferBaseTable } from "./baseTable"
import type { Cell, ColumnInfo, RowChange, SchemaColumn, SchemaSnapshot } from "./mysql"

/** A row the user added in the grid; `values` holds only the columns they set. */
export interface PendingInsert {
  id: string
  values: Readonly<Record<number, Cell>>
}

/** Pending edits against one rows result. Row and column keys are result indexes. */
export interface GridEdits {
  updates: Readonly<Record<number, Readonly<Record<number, Cell>>>>
  deletes: readonly number[]
  inserts: readonly PendingInsert[]
}

export interface EditTarget {
  database: string
  table: string
  /** Result column indexes forming the primary key. */
  keyIndexes: readonly number[]
  /** Schema column for each result column, aligned by index. */
  schemaColumns: readonly SchemaColumn[]
}

export type EditTargetResult =
  { editable: true; target: EditTarget } | { editable: false; reason: string }

export const EMPTY_EDITS: GridEdits = { updates: {}, deletes: [], inserts: [] }

/**
 * Decides whether a result can be edited: every column comes from the same base table, that
 * table has a primary key, and every key column is part of the result.
 */
export function resolveEditTarget(
  columns: readonly ColumnInfo[],
  schema: SchemaSnapshot | null,
  database: string | null,
  statement = "",
): EditTargetResult {
  if (columns.length === 0) return { editable: false, reason: "No columns" }
  if (!database || !schema || schema.database !== database) {
    return { editable: false, reason: "Select a database to edit rows" }
  }
  const table = originTable(columns, statement, database)
  if (!table) {
    return { editable: false, reason: "Read only: rows don't come from a single table" }
  }
  const snapshot = schema.tables.find((t) => t.name === table)
  if (!snapshot || snapshot.kind !== "table") {
    return { editable: false, reason: `Read only: ${table} isn't a base table in ${database}` }
  }
  const schemaColumns = columns.map((c) => snapshot.columns.find((s) => s.name === c.name))
  if (
    schemaColumns.some((c) => c === undefined) ||
    new Set(columns.map((c) => c.name)).size !== columns.length
  ) {
    return { editable: false, reason: "Read only: some columns are aliased or computed" }
  }
  const primary = snapshot.columns.filter((c) => c.isPrimary)
  if (primary.length === 0)
    return { editable: false, reason: `Read only: ${table} has no primary key` }
  const keyIndexes = primary.map((p) => columns.findIndex((c) => c.name === p.name))
  if (keyIndexes.some((i) => i === -1)) {
    return { editable: false, reason: "Read only: select every primary key column to edit" }
  }
  return {
    editable: true,
    target: { database, table, keyIndexes, schemaColumns: schemaColumns as SchemaColumn[] },
  }
}

/**
 * The single table the rows came from. Uses the column metadata when the backend reports it and
 * otherwise reads the statement; a table qualified with another database is rejected.
 */
export function originTable(
  columns: readonly ColumnInfo[],
  statement: string,
  database: string | null,
): string | null {
  const reported = new Set(columns.map((c) => c.table))
  if (reported.size === 1) {
    const [only] = [...reported]
    if (only) return only
  }
  const inferred = inferBaseTable(statement)
  if (!inferred) return null
  if (inferred.database && database && inferred.database !== database) return null
  return inferred.table
}

/** Records an edit; setting a cell back to its original value removes the edit. */
export function setCellEdit(
  edits: GridEdits,
  rows: readonly Cell[][],
  row: number,
  col: number,
  cell: Cell,
): GridEdits {
  const original = rows[row]?.[col]
  const { [col]: _dropped, ...otherCols } = edits.updates[row] ?? {}
  const nextCols =
    original && cellsEqual(original, cell) ? otherCols : { ...otherCols, [col]: cell }
  const { [row]: _row, ...otherRows } = edits.updates
  const updates = Object.keys(nextCols).length === 0 ? otherRows : { ...otherRows, [row]: nextCols }
  return { ...edits, updates }
}

export function toggleRowDelete(edits: GridEdits, row: number): GridEdits {
  const deletes = edits.deletes.includes(row)
    ? edits.deletes.filter((r) => r !== row)
    : [...edits.deletes, row].sort((a, b) => a - b)
  return { ...edits, deletes }
}

export function addInsert(edits: GridEdits, id: string): GridEdits {
  return { ...edits, inserts: [...edits.inserts, { id, values: {} }] }
}

export function setInsertValue(edits: GridEdits, id: string, col: number, cell: Cell): GridEdits {
  return {
    ...edits,
    inserts: edits.inserts.map((insert) =>
      insert.id === id ? { ...insert, values: { ...insert.values, [col]: cell } } : insert,
    ),
  }
}

export function removeInsert(edits: GridEdits, id: string): GridEdits {
  return { ...edits, inserts: edits.inserts.filter((insert) => insert.id !== id) }
}

function updatedRows(edits: GridEdits): number[] {
  return Object.keys(edits.updates)
    .map(Number)
    .filter((row) => !edits.deletes.includes(row))
    .sort((a, b) => a - b)
}

/** Number of row-level changes Apply would send. */
export function pendingCount(edits: GridEdits): number {
  return updatedRows(edits).length + edits.deletes.length + edits.inserts.length
}

function keyFor(
  target: EditTarget,
  columns: readonly ColumnInfo[],
  row: readonly Cell[],
): Record<string, Cell> {
  return Object.fromEntries(target.keyIndexes.map((i) => [columns[i].name, row[i]]))
}

function byName(
  columns: readonly ColumnInfo[],
  values: Readonly<Record<number, Cell>>,
): Record<string, Cell> {
  return Object.fromEntries(
    Object.entries(values).map(([col, cell]) => [columns[Number(col)].name, cell]),
  )
}

/**
 * Converts pending edits into the batch for `mysql_apply_changes`. Deletes go first so freed
 * unique keys can be reused, then updates, then inserts. Keys always use the original values,
 * so editing a primary key column still targets the right row.
 */
export function buildRowChanges(
  edits: GridEdits,
  target: EditTarget,
  columns: readonly ColumnInfo[],
  rows: readonly Cell[][],
): RowChange[] {
  const deletes: RowChange[] = edits.deletes
    .filter((row) => rows[row] !== undefined)
    .map((row) => ({ type: "delete", key: keyFor(target, columns, rows[row]) }))
  const updates: RowChange[] = updatedRows(edits)
    .filter((row) => rows[row] !== undefined)
    .map((row) => ({
      type: "update",
      key: keyFor(target, columns, rows[row]),
      set: byName(columns, edits.updates[row]),
    }))
  const inserts: RowChange[] = edits.inserts.map((insert) => ({
    type: "insert",
    values: byName(columns, insert.values),
  }))
  return [...deletes, ...updates, ...inserts]
}

export type RowRef = { kind: "existing"; index: number } | { kind: "insert"; id: string }

/** A grid row with pending edits applied. `undefined` cells in inserts mean "use the default". */
export interface DisplayRow {
  ref: RowRef
  cells: readonly (Cell | undefined)[]
  changed: readonly boolean[]
  deleted: boolean
}

/** Merges original rows with pending edits; inserted rows come last. */
export function displayRows(
  rows: readonly Cell[][],
  columnCount: number,
  edits: GridEdits,
): DisplayRow[] {
  const indexes = Array.from({ length: columnCount }, (_, i) => i)
  const existing = rows.map((row, index): DisplayRow => {
    const updates = edits.updates[index]
    return {
      ref: { kind: "existing", index },
      cells: updates ? indexes.map((col) => updates[col] ?? row[col]) : row,
      changed: indexes.map((col) => updates?.[col] !== undefined),
      deleted: edits.deletes.includes(index),
    }
  })
  const inserted = edits.inserts.map((insert): DisplayRow => ({
    ref: { kind: "insert", id: insert.id },
    cells: indexes.map((col) => insert.values[col]),
    changed: indexes.map((col) => insert.values[col] !== undefined),
    deleted: false,
  }))
  return [...existing, ...inserted]
}
