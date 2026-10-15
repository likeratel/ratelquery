/** SQL text for Athena (Trino dialect), where identifiers are quoted with double quotes. */

/** Double-quotes `name`, doubling any `"` inside it. */
export function quoteAthenaIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** `SELECT * FROM "database"."table" LIMIT n`, ready to run in any database. */
export function athenaSelectRowsSql(database: string, table: string, limit: number): string {
  const target = `${quoteAthenaIdentifier(database)}.${quoteAthenaIdentifier(table)}`
  return `SELECT * FROM ${target} LIMIT ${limit}`
}
