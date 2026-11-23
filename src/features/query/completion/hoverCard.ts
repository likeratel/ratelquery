/**
 * What a hover over a name in the editor shows: the column, table or database it resolves to in
 * the cached schema, as plain data. `hover.ts` turns the cards into DOM.
 */

import type { SchemaSnapshot } from "../../../lib/mysql"
import type { IdentifierAt } from "../../../lib/sqlScope"
import { resolveDatabase } from "./catalog"
import {
  qualifierTable,
  refTable,
  resolveColumns,
  scopeRefFor,
  type Lookup,
  type ResolvedColumn,
  type ResolvedTable,
} from "./resolve"

export type HoverTarget =
  | { kind: "column"; matches: ResolvedColumn[] }
  | { kind: "table"; resolved: ResolvedTable }
  | { kind: "database"; name: string; snapshot: SchemaSnapshot | null }

export interface HoverRow {
  name: string
  type: string
  primary: boolean
}

export interface HoverCard {
  title: string
  /** "column", "table", "view" or "database". */
  badge: string
  /** Where it lives: `db.table` for a column, the database for a table. */
  location?: string
  /** The column type as `information_schema` writes it. */
  type?: string
  facts: string[]
  comment?: string
  rows?: HoverRow[]
  /** Columns left out of `rows`. */
  more?: number
}

/** A table card lists this many columns. */
export const HOVER_COLUMN_LIMIT = 12

function databaseTarget(name: string, lookup: Lookup): HoverTarget | null {
  const database = resolveDatabase(lookup.catalog, name)
  if (!database) return null
  // Only what is cached: hovering a database name must not load its whole schema.
  return { kind: "database", name: database, snapshot: lookup.catalog.schemas[database] ?? null }
}

const tableTarget = (resolved: ResolvedTable | null): HoverTarget | null =>
  resolved ? { kind: "table", resolved } : null

/** `[t]` or `[db, t]` as a table. */
function pathTable(path: readonly string[], lookup: Lookup): ResolvedTable | null {
  if (path.length === 1)
    return refTable({ database: null, table: path[0] as string, alias: null }, lookup)
  if (path.length === 2) {
    const [database, table] = path as [string, string]
    return refTable({ database, table, alias: null }, lookup)
  }
  return null
}

/** A name followed by `.`: an alias or table (`o.id`), a database (`spam.t`), or `db.table`. */
function qualifierTarget(id: IdentifierAt, lookup: Lookup): HoverTarget | null {
  const { path, tables } = id
  if (path.length === 2) return tableTarget(pathTable(path, lookup))
  if (path.length !== 1) return null
  const name = path[0] as string
  if (scopeRefFor(tables, name)) return tableTarget(qualifierTable(name, tables, lookup))
  return databaseTarget(name, lookup) ?? tableTarget(pathTable(path, lookup))
}

/** What the name under the pointer refers to, or null when the schema has nothing for it. */
export function hoverTarget(id: IdentifierAt, lookup: Lookup): HoverTarget | null {
  if (id.qualifies) return qualifierTarget(id, lookup)
  const { path, tables, position } = id
  if (position === "database") {
    return path.length === 1 ? databaseTarget(path[0] as string, lookup) : null
  }
  if (position === "table") return tableTarget(pathTable(path, lookup))
  const matches = resolveColumns(path, tables, lookup)
  if (matches.length > 0) return { kind: "column", matches }
  if (path.length === 1) {
    const name = path[0] as string
    // An alias where it is defined (`FROM orders o`), then a table, then a database.
    if (scopeRefFor(tables, name)) return tableTarget(qualifierTable(name, tables, lookup))
    return tableTarget(pathTable(path, lookup)) ?? databaseTarget(name, lookup)
  }
  return tableTarget(pathTable(path, lookup))
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

function columnCard({ database, table, column }: ResolvedColumn): HoverCard {
  const facts = [
    ...(column.isPrimary ? ["PRIMARY KEY"] : []),
    ...(column.isAutoIncrement ? ["AUTO_INCREMENT"] : []),
    column.nullable ? "NULL" : "NOT NULL",
    ...(column.defaultValue !== null ? [`DEFAULT ${column.defaultValue}`] : []),
  ]
  return {
    title: column.name,
    badge: "column",
    location: `${database}.${table.name}`,
    type: column.typeName,
    facts,
    ...(column.comment ? { comment: column.comment } : {}),
  }
}

function tableCard({ database, table }: ResolvedTable): HoverCard {
  const rows = table.columns.slice(0, HOVER_COLUMN_LIMIT).map((c) => ({
    name: c.name,
    type: c.typeName,
    primary: c.isPrimary,
  }))
  const more = table.columns.length - rows.length
  return {
    title: table.name,
    badge: table.kind,
    location: database,
    facts: [plural(table.columns.length, "column")],
    rows,
    ...(more > 0 ? { more } : {}),
  }
}

function databaseCard(name: string, snapshot: SchemaSnapshot | null): HoverCard {
  return {
    title: name,
    badge: "database",
    facts: snapshot ? [plural(snapshot.tables.length, "table")] : [],
  }
}

/** Cards for a target: one per column when an unqualified name is in several tables. */
export function hoverCards(target: HoverTarget): HoverCard[] {
  switch (target.kind) {
    case "column":
      return target.matches.map(columnCard)
    case "table":
      return [tableCard(target.resolved)]
    case "database":
      return [databaseCard(target.name, target.snapshot)]
  }
}
