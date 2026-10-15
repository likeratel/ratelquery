/** SQL text for Athena (Trino dialect), where identifiers are quoted with double quotes. */

/**
 * Trino reserved keywords: as a bare identifier they are a syntax error, so completion inserts
 * them in double quotes. Non-reserved words (`date`, `year`, `status`) stay bare.
 */
const RESERVED_WORDS = new Set(
  `alter and as between by case cast constraint create cross cube current_catalog current_date
  current_path current_role current_schema current_time current_timestamp current_user deallocate
  delete describe distinct drop else end escape except execute exists extract false for from full
  group grouping having in inner insert intersect into is join json_array json_exists json_object
  json_query json_table json_value left like listagg localtime localtimestamp natural normalize not
  null on or order outer prepare recursive right rollup select skip table then trim true uescape
  union unnest using values when where with`.split(/\s+/),
)

/** Unquoted Athena identifiers: a letter or `_`, then letters, digits and `_`. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Double-quotes `name`, doubling any `"` inside it. */
export function quoteAthenaIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Whether `name` must be double-quoted to be read back as the same identifier. */
export function athenaNeedsQuoting(name: string): boolean {
  return !PLAIN_IDENTIFIER.test(name) || RESERVED_WORDS.has(name.toLowerCase())
}

/** `SELECT * FROM "database"."table" LIMIT n`, ready to run in any database. */
export function athenaSelectRowsSql(database: string, table: string, limit: number): string {
  const target = `${quoteAthenaIdentifier(database)}.${quoteAthenaIdentifier(table)}`
  return `SELECT * FROM ${target} LIMIT ${limit}`
}
