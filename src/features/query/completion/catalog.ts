/**
 * Completion options built from cached schema snapshots. Options for a database are built once
 * per snapshot (a refetch replaces the snapshot and its `fetchedAt`) so a completion request with
 * hundreds of tables and thousands of columns only concatenates ready-made arrays. Names that
 * need quoting are inserted with the dialect's quotes (backticks for MySQL, `"` for Athena).
 */

import type { Completion } from "@codemirror/autocomplete"
import type { SchemaSnapshot, SchemaTable } from "../../../lib/mysql"
import { dialectIdentifierText, MYSQL_DIALECT, type SqlDialect } from "../../../lib/sqlDialect"

/** What completion needs from the session: the database names and the schemas loaded so far. */
export interface SchemaCatalog {
  currentDatabase: string | null
  databases: readonly string[]
  schemas: Readonly<Record<string, SchemaSnapshot>>
}

/** Ranking: columns of the statement's tables, then aliases, tables, databases; keywords are -1. */
export const BOOST = { column: 40, alias: 35, table: 20, database: 10 } as const
/** Added when the typed word equals the option's name (ignoring case). */
export const EXACT_MATCH_BOOST = 50
const MAX_BOOST = 99

interface SchemaIndex {
  fetchedAt: string
  tableOptions: readonly Completion[]
  byName: ReadonlyMap<string, SchemaTable>
  byLowerName: ReadonlyMap<string, SchemaTable>
  /** Filled on first use; a table's columns are needed only once it appears in a statement. */
  columnOptions: Map<SchemaTable, readonly Completion[]>
}

/** Per-dialect caches; there are only two dialects, each keeping its own quoted `apply` text. */
const schemaIndexes = new Map<SqlDialect, WeakMap<SchemaSnapshot, SchemaIndex>>()
const databaseOptionLists = new Map<SqlDialect, WeakMap<readonly string[], readonly Completion[]>>()

function cacheFor<K extends object, V>(
  caches: Map<SqlDialect, WeakMap<K, V>>,
  dialect: SqlDialect,
): WeakMap<K, V> {
  const existing = caches.get(dialect)
  if (existing) return existing
  const created = new WeakMap<K, V>()
  caches.set(dialect, created)
  return created
}

function nameOption(
  dialect: SqlDialect,
  name: string,
  rest: Omit<Completion, "label" | "apply">,
): Completion {
  return dialect.needsQuoting(name)
    ? { label: name, apply: dialectIdentifierText(dialect, name), ...rest }
    : { label: name, ...rest }
}

function buildIndex(snapshot: SchemaSnapshot, dialect: SqlDialect): SchemaIndex {
  const byLowerName = new Map<string, SchemaTable>()
  for (const table of snapshot.tables) {
    const key = table.name.toLowerCase()
    if (!byLowerName.has(key)) byLowerName.set(key, table)
  }
  return {
    fetchedAt: snapshot.fetchedAt,
    tableOptions: snapshot.tables.map((table) =>
      nameOption(dialect, table.name, { type: "type", detail: table.kind, boost: BOOST.table }),
    ),
    byName: new Map(snapshot.tables.map((table) => [table.name, table])),
    byLowerName,
    columnOptions: new Map(),
  }
}

function indexFor(snapshot: SchemaSnapshot, dialect: SqlDialect): SchemaIndex {
  const indexes = cacheFor(schemaIndexes, dialect)
  const cached = indexes.get(snapshot)
  if (cached && cached.fetchedAt === snapshot.fetchedAt) return cached
  const index = buildIndex(snapshot, dialect)
  indexes.set(snapshot, index)
  return index
}

/** Tables and views of `snapshot` as completion options. */
export function tableOptions(
  snapshot: SchemaSnapshot,
  dialect: SqlDialect = MYSQL_DIALECT,
): readonly Completion[] {
  return indexFor(snapshot, dialect).tableOptions
}

/** The table called `name`: an exact match first, then one that differs only in case. */
export function findTable(
  snapshot: SchemaSnapshot,
  name: string,
  dialect: SqlDialect = MYSQL_DIALECT,
): SchemaTable | null {
  const index = indexFor(snapshot, dialect)
  return index.byName.get(name) ?? index.byLowerName.get(name.toLowerCase()) ?? null
}

/** Columns of `table` (from `snapshot`), with the column type and table name as detail. */
export function columnOptions(
  snapshot: SchemaSnapshot,
  table: SchemaTable,
  dialect: SqlDialect = MYSQL_DIALECT,
): readonly Completion[] {
  const index = indexFor(snapshot, dialect)
  const cached = index.columnOptions.get(table)
  if (cached) return cached
  const options = table.columns.map((column) =>
    nameOption(dialect, column.name, {
      type: "property",
      detail: `${column.typeName} · ${table.name}`,
      boost: BOOST.column,
    }),
  )
  index.columnOptions.set(table, options)
  return options
}

export function databaseOptions(
  databases: readonly string[],
  dialect: SqlDialect = MYSQL_DIALECT,
): readonly Completion[] {
  const lists = cacheFor(databaseOptionLists, dialect)
  const cached = lists.get(databases)
  if (cached) return cached
  const options = databases.map((name) =>
    nameOption(dialect, name, { type: "namespace", detail: "database", boost: BOOST.database }),
  )
  lists.set(databases, options)
  return options
}

/** The database called `name` (exact match first, then ignoring case), or null if unknown. */
export function resolveDatabase(catalog: SchemaCatalog, name: string): string | null {
  const known = [
    ...(catalog.currentDatabase ? [catalog.currentDatabase] : []),
    ...catalog.databases,
    ...Object.keys(catalog.schemas),
  ]
  if (known.includes(name)) return name
  const lowered = name.toLowerCase()
  return known.find((db) => db.toLowerCase() === lowered) ?? null
}

/** Raises an option whose name equals what was typed (ignoring case). */
export function withExactMatchBoost(option: Completion, typed: string): Completion {
  if (typed === "" || option.label.toLowerCase() !== typed.toLowerCase()) return option
  return { ...option, boost: Math.min(MAX_BOOST, (option.boost ?? 0) + EXACT_MATCH_BOOST) }
}
