import { cellsEqual } from "./cellEdit"
import { inferBaseTable } from "./baseTable"
import type {
  Cell,
  ColumnInfo,
  QueryResult,
  RowChange,
  SchemaColumn,
  SchemaSnapshot,
} from "./mysql"

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
 * The item called `name`: an exact match first, otherwise the only one that differs just in
 * letter case. MySQL column names never depend on case, and table and database names don't
 * under `lower_case_table_names`, so a query may spell them differently from the schema.
 */
export function findByName<T>(
  items: readonly T[],
  name: string,
  nameOf: (item: T) => string,
): T | undefined {
  const exact = items.find((item) => nameOf(item) === name)
  if (exact !== undefined) return exact
  const lower = name.toLowerCase()
  const folded = items.filter((item) => nameOf(item).toLowerCase() === lower)
  return folded.length === 1 ? folded[0] : undefined
}

/**
 * The database a result's rows would be edited in: the one its table is qualified with in the
 * statement (spelled as in `known` when that is unambiguous), else the one the run used.
 */
export function editDatabase(
  statement: string,
  ranDatabase: string | null,
  known: readonly string[] = [],
): string | null {
  const qualified = inferBaseTable(statement)?.database
  if (!qualified) return ranDatabase
  return findByName(known, qualified, (name) => name) ?? qualified
}

/**
 * The databases whose schema decides whether the rows results of one run can be edited. Only
 * results read from a single table count; anything else stays read only whatever the schema.
 */
export function editSchemaDatabases(
  results: readonly QueryResult[],
  ranDatabase: string | null,
  known: readonly string[] = [],
): string[] {
  const databases = results
    .filter((r) => r.kind === "rows" && inferBaseTable(r.statement) !== null)
    .map((r) => editDatabase(r.statement, ranDatabase, known))
    .filter((database): database is string => database !== null)
  return [...new Set(databases)]
}

/**
 * Decides whether a result can be edited: every column comes from the same base table, that
 * table has a primary key, and every key column is part of the result. The target spells the
 * table and columns as the schema does, since the apply command matches them exactly.
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
  const snapshot = findByName(schema.tables, table, (t) => t.name)
  if (!snapshot || snapshot.kind !== "table") {
    return { editable: false, reason: `Read only: ${table} isn't a base table in ${database}` }
  }
  const schemaColumns = columns.map((c) => findByName(snapshot.columns, c.name, (s) => s.name))
  if (
    schemaColumns.some((c) => c === undefined) ||
    new Set(schemaColumns).size !== columns.length
  ) {
    return { editable: false, reason: "Read only: some columns are aliased or computed" }
  }
  const primary = snapshot.columns.filter((c) => c.isPrimary)
  if (primary.length === 0)
    return { editable: false, reason: `Read only: ${snapshot.name} has no primary key` }
  const keyIndexes = primary.map((p) => schemaColumns.indexOf(p))
  if (keyIndexes.some((i) => i === -1)) {
    return { editable: false, reason: "Read only: select every primary key column to edit" }
  }
  return {
    editable: true,
    target: {
      database,
      table: snapshot.name,
      keyIndexes,
      schemaColumns: schemaColumns as SchemaColumn[],
    },
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
  if (inferred.database && database && !sameName(inferred.database, database)) return null
  return inferred.table
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

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

function keyFor(target: EditTarget, row: readonly Cell[]): Record<string, Cell> {
  return Object.fromEntries(target.keyIndexes.map((i) => [target.schemaColumns[i].name, row[i]]))
}

/** Values keyed by the schema's column names; the query may spell them in another case. */
function byName(target: EditTarget, values: Readonly<Record<number, Cell>>): Record<string, Cell> {
  return Object.fromEntries(
    Object.entries(values).map(([col, cell]) => [target.schemaColumns[Number(col)].name, cell]),
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
  rows: readonly Cell[][],
): RowChange[] {
  const deletes: RowChange[] = edits.deletes
    .filter((row) => rows[row] !== undefined)
    .map((row) => ({ type: "delete", key: keyFor(target, rows[row]) }))
  const updates: RowChange[] = updatedRows(edits)
    .filter((row) => rows[row] !== undefined)
    .map((row) => ({
      type: "update",
      key: keyFor(target, rows[row]),
      set: byName(target, edits.updates[row]),
    }))
  const inserts: RowChange[] = edits.inserts.map((insert) => ({
    type: "insert",
    values: byName(target, insert.values),
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
