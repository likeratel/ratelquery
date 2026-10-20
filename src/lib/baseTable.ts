/**
 * Works out which base table a single SELECT reads from, so its rows can be edited in the grid.
 * The backend cannot report a column's origin table, so this is a conservative text check: it
 * only accepts `SELECT ... FROM [db.]table [AS alias] [WHERE/ORDER BY/LIMIT ...]` with no joins,
 * unions, grouping or subqueries. Anything else is treated as read only.
 */

import { blankStringsAndComments } from "./sqlContext"

export interface BaseTable {
  database: string | null
  table: string
}

/** A bare identifier, or a backtick-quoted one where a doubled backtick stands for one. */
const IDENT = "(?:`((?:[^`]|``)+)`|([A-Za-z_][A-Za-z0-9_$]*))"
const FROM_PATTERN = new RegExp(`\\bfrom\\s+(?:${IDENT}\\s*\\.\\s*)?${IDENT}`, "i")
// A second table in the FROM list is caught after the table name below, so commas elsewhere
// (`ORDER BY a, b DESC`, `IN (1, 2)`) don't make a result read only.
const READ_ONLY_KEYWORDS =
  /\b(join|union|group\s+by|having|distinct|procedure|into\s+outfile|straight_join)\b/i

const unquote = (quoted: string | undefined, bare: string | undefined): string | null =>
  quoted !== undefined ? quoted.replaceAll("``", "`") : (bare ?? null)

export function inferBaseTable(statement: string): BaseTable | null {
  const sql = blankStringsAndComments(statement).trim()
  if (!/^select\b/i.test(sql)) return null
  if (/\bselect\b[\s\S]*\bselect\b/i.test(sql)) return null // subquery or union
  const fromMatch = FROM_PATTERN.exec(sql)
  if (!fromMatch) return null
  const afterFrom = sql.slice(fromMatch.index + fromMatch[0].length)
  if (READ_ONLY_KEYWORDS.test(sql)) return null
  // A second table in the FROM list (`FROM a, b`) is a join as well.
  if (/^\s*(?:as\s+)?(?:`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_$]*)?\s*,/i.test(afterFrom)) return null
  const database = unquote(fromMatch[1], fromMatch[2])
  const table = unquote(fromMatch[3], fromMatch[4])
  if (!table) return null
  return { database, table }
}
