/**
 * Works out which base table a single SELECT reads from, so its rows can be edited in the grid.
 * The backend cannot report a column's origin table, so this is a conservative text check: it
 * only accepts `SELECT ... FROM [db.]table [AS alias] [WHERE/ORDER BY/LIMIT ...]` with no joins,
 * unions, grouping or subqueries. Anything else is treated as read only.
 */

export interface BaseTable {
  database: string | null
  table: string
}

const IDENT = "(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))"
const FROM_PATTERN = new RegExp(`\\bfrom\\s+(?:${IDENT}\\s*\\.\\s*)?${IDENT}`, "i")
const READ_ONLY_KEYWORDS =
  /\b(join|union|group\s+by|having|distinct|limit\s+\d+\s*,|procedure|into\s+outfile|straight_join)\b|,\s*(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)\s+(?=(?:as\s+)?[A-Za-z_`]+\s*(?:where|order|limit|$))/i

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
}

/** Removes the contents of string literals so keywords inside them don't count. */
function blankStrings(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")
}

export function inferBaseTable(statement: string): BaseTable | null {
  const sql = blankStrings(stripComments(statement)).trim()
  if (!/^select\b/i.test(sql)) return null
  if (/\bselect\b[\s\S]*\bselect\b/i.test(sql)) return null // subquery or union
  const fromMatch = FROM_PATTERN.exec(sql)
  if (!fromMatch) return null
  const afterFrom = sql.slice(fromMatch.index + fromMatch[0].length)
  if (READ_ONLY_KEYWORDS.test(sql)) return null
  // A second table in the FROM list (`FROM a, b`) is a join as well.
  if (/^\s*(?:as\s+)?(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)?\s*,/i.test(afterFrom)) return null
  const database = fromMatch[1] ?? fromMatch[2] ?? null
  const table = fromMatch[3] ?? fromMatch[4]
  if (!table) return null
  return { database, table }
}
