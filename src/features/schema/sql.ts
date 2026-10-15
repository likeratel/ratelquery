import { currentSettings } from "../../state/settingsStore"

/** Row cap for "Select rows": the user's default query limit. */
export const selectRowsLimit = (): number => currentSettings().query.defaultLimit

/** Quotes a MySQL identifier with backticks, doubling any backtick inside it. */
export function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``
}

/** `SELECT * FROM \`table\` LIMIT n`; the query tab supplies the database. */
export function selectRowsSql(table: string, limit: number = selectRowsLimit()): string {
  return `SELECT * FROM ${quoteIdentifier(table)} LIMIT ${limit}`
}
