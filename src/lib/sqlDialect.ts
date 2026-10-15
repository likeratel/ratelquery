/**
 * What differs between the SQL engines of a query tab: how statements are tokenized and split
 * (`"..."` is a string in MySQL, an identifier in Athena) and how a name is quoted when
 * completion inserts it.
 */
import { athenaNeedsQuoting, quoteAthenaIdentifier } from "./athenaSql"
import type { QueryEngine } from "./queryTabs"
import { ANSI_SYNTAX, MYSQL_SYNTAX, type SqlSyntax } from "./sqlContext"
import { needsQuoting, quoteIdentifier } from "./sqlIdentifiers"

/** lang-sql dialect names the editor understands; see `SqlEditor`. */
export type EditorDialect = "mysql" | "postgresql"

export interface SqlDialect {
  engine: QueryEngine
  syntax: SqlSyntax
  /**
   * lang-sql dialect for highlighting and keywords. Athena uses PostgreSQL, the closest lang-sql
   * has to Trino: standard keywords and `"..."` identifiers.
   */
  editor: EditorDialect
  /** Quotes `name` unconditionally. */
  quoteIdentifier: (name: string) => string
  /** Whether `name` must be quoted to be read back as the same identifier. */
  needsQuoting: (name: string) => boolean
}

export const MYSQL_DIALECT: SqlDialect = Object.freeze({
  engine: "mysql",
  syntax: MYSQL_SYNTAX,
  editor: "mysql",
  quoteIdentifier,
  needsQuoting,
})

export const ATHENA_DIALECT: SqlDialect = Object.freeze({
  engine: "athena",
  syntax: ANSI_SYNTAX,
  editor: "postgresql",
  quoteIdentifier: quoteAthenaIdentifier,
  needsQuoting: athenaNeedsQuoting,
})

export function dialectFor(engine: QueryEngine): SqlDialect {
  return engine === "athena" ? ATHENA_DIALECT : MYSQL_DIALECT
}

/** `name` as it should be typed into SQL of `dialect`: bare when possible, otherwise quoted. */
export function dialectIdentifierText(dialect: SqlDialect, name: string): string {
  return dialect.needsQuoting(name) ? dialect.quoteIdentifier(name) : name
}
