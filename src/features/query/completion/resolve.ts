/**
 * Resolves names written in a statement (`col`, `alias.col`, `db.table`, ...) to the tables and
 * columns of the cached schema snapshots. Shared by completion and hover. A lookup records the
 * databases it needed but didn't have, so the caller can load them.
 */

import type { SchemaColumn, SchemaSnapshot, SchemaTable } from "../../../lib/mysql"
import type { SqlDialect } from "../../../lib/sqlDialect"
import type { TableRef } from "../../../lib/sqlScope"
import { findTable, resolveDatabase, type SchemaCatalog } from "./catalog"

export type SchemaLookup = (database: string) => SchemaSnapshot | null

/** What resolution reads: the catalog, a schema lookup and the dialect's name rules. */
export interface Lookup {
  catalog: SchemaCatalog
  schemaOf: SchemaLookup
  dialect: SqlDialect
}

export interface ResolvedTable {
  database: string
  snapshot: SchemaSnapshot
  table: SchemaTable
}

export interface ResolvedColumn extends ResolvedTable {
  column: SchemaColumn
}

/** A lookup over `catalog` that adds every database it had no schema for to `missing`. */
export function createLookup(
  catalog: SchemaCatalog,
  dialect: SqlDialect,
  missing: Set<string>,
): Lookup {
  const schemaOf: SchemaLookup = (database) => {
    const snapshot = catalog.schemas[database]
    if (!snapshot) missing.add(database)
    return snapshot ?? null
  }
  return { catalog, schemaOf, dialect }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The table a qualifier names: an alias first, then an unaliased table of the statement. */
export function scopeRefFor(tables: readonly TableRef[], name: string): TableRef | null {
  return (
    tables.find((t) => t.alias !== null && sameName(t.alias, name)) ??
    tables.find((t) => t.alias === null && t.table !== null && sameName(t.table, name)) ??
    null
  )
}

/** The table `ref` points at; null when unknown or its schema is still loading. */
export function refTable(ref: TableRef, lookup: Lookup): ResolvedTable | null {
  const { catalog, schemaOf, dialect } = lookup
  if (ref.table === null) return null
  const database = ref.database ? resolveDatabase(catalog, ref.database) : catalog.currentDatabase
  const snapshot = database ? schemaOf(database) : null
  const table = snapshot ? findTable(snapshot, ref.table, dialect) : null
  return database && snapshot && table ? { database, snapshot, table } : null
}

/** The table a one-part qualifier means: an alias or table of the statement, else one in the current database. */
export function qualifierTable(
  name: string,
  tables: readonly TableRef[],
  lookup: Lookup,
): ResolvedTable | null {
  const ref = scopeRefFor(tables, name)
  if (ref) return refTable(ref, lookup)
  return refTable({ database: null, table: name, alias: null }, lookup)
}

function columnOf(table: SchemaTable, name: string): SchemaColumn | null {
  return (
    table.columns.find((c) => c.name === name) ??
    table.columns.find((c) => sameName(c.name, name)) ??
    null
  )
}

function withColumn(resolved: ResolvedTable | null, name: string): ResolvedColumn[] {
  const column = resolved ? columnOf(resolved.table, name) : null
  return resolved && column ? [{ ...resolved, column }] : []
}

/**
 * The columns `path` can mean in a statement reading `tables`: `[col]` matches that column in
 * every table of the statement (more than one when it is ambiguous), `[q, col]` a column of an
 * alias or table, `[db, table, col]` a column of a qualified table.
 */
export function resolveColumns(
  path: readonly string[],
  tables: readonly TableRef[],
  lookup: Lookup,
): ResolvedColumn[] {
  if (path.length === 3) {
    const [database, table, name] = path as [string, string, string]
    return withColumn(refTable({ database, table, alias: null }, lookup), name)
  }
  if (path.length === 2) {
    const [qualifier, name] = path as [string, string]
    return withColumn(qualifierTable(qualifier, tables, lookup), name)
  }
  if (path.length !== 1) return []
  const name = path[0] as string
  const seen = new Set<SchemaTable>()
  return tables.flatMap((ref) => {
    const resolved = refTable(ref, lookup)
    if (!resolved || seen.has(resolved.table)) return []
    seen.add(resolved.table)
    return withColumn(resolved, name)
  })
}
