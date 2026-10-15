/**
 * Safety rewrites and checks applied before a statement runs: a default LIMIT for unbounded
 * SELECTs and a danger classification for statements that change many rows or the schema.
 * Matching runs on a masked copy (strings, quoted identifiers and comments blanked, same
 * length) so keywords inside literals or comments never count.
 */
import { skipComment, skipQuoted } from "./sqlContext"

/**
 * Same-length copy of `sql` with comment text and the inside of quoted runs (strings and
 * backtick identifiers) replaced by spaces. Quote characters stay so tokens stay separated.
 */
export function maskSql(sql: string): string {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const commentEnd = skipComment(sql, i)
    if (commentEnd !== -1) {
      out += " ".repeat(commentEnd - i)
      i = commentEnd
      continue
    }
    const ch = sql[i] as string
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipQuoted(sql, i)
      const closed = end - i >= 2 && sql[end - 1] === ch
      out += closed ? ch + " ".repeat(end - i - 2) + ch : ch + " ".repeat(end - i - 1)
      i = end
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Keeps only the text at parenthesis depth 0; nested text and the parentheses become spaces. */
function topLevel(masked: string): string {
  let depth = 0
  let out = ""
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i] as string
    if (ch === "(") {
      depth += 1
      out += " "
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1)
      out += " "
    } else {
      out += depth === 0 ? ch : " "
    }
  }
  return out
}

/** First word of the masked text, ignoring leading parentheses, upper-cased. */
function leadingKeyword(masked: string): string {
  const match = /^[\s(]*([A-Za-z_]+)/.exec(masked)
  return match ? (match[1] as string).toUpperCase() : ""
}

/** The verb of the statement; for `WITH ...` the first top-level DML keyword after the CTEs. */
function statementVerb(masked: string, top: string): string {
  const first = leadingKeyword(masked)
  if (first !== "WITH") return first
  const main = /\b(SELECT|UPDATE|DELETE|INSERT|REPLACE)\b/i.exec(top.replace(/^\s*WITH\b/i, ""))
  return main ? (main[1] as string).toUpperCase() : "WITH"
}

/** Offset just past the last code character, excluding a terminating `;`. */
function codeEnd(masked: string): number {
  let end = masked.trimEnd().length
  if (masked[end - 1] === ";") end = masked.slice(0, end - 1).trimEnd().length
  return end
}

const LOCKING_CLAUSE = /\b(FOR\s+(UPDATE|SHARE)|LOCK\s+IN\s+SHARE\s+MODE)\b/i

/**
 * Adds ` LIMIT n` to a single SELECT (including UNIONs, subqueries and `WITH ... SELECT`) that
 * has no top-level LIMIT. The LIMIT goes before a locking clause (`FOR UPDATE`, `FOR SHARE`,
 * `LOCK IN SHARE MODE`) and before a trailing `;` or comment. Statements with a top-level INTO
 * (`INTO OUTFILE`, `INTO @var`) and anything that is not a SELECT, including SHOW and EXPLAIN,
 * are returned unchanged.
 */
export function withDefaultLimit(statement: string, limit: number): string {
  const masked = maskSql(statement)
  const top = topLevel(masked)
  if (statementVerb(masked, top) !== "SELECT") return statement
  if (/\bLIMIT\b/i.test(top) || /\bINTO\b/i.test(top)) return statement
  const clause = `LIMIT ${limit}`
  const end = codeEnd(masked)
  const locking = LOCKING_CLAUSE.exec(top.slice(0, end))
  if (locking) {
    const head = statement.slice(0, locking.index).trimEnd()
    return `${head} ${clause} ${statement.slice(locking.index)}`
  }
  return `${statement.slice(0, end)} ${clause}${statement.slice(end)}`
}

const DANGER_REASONS = {
  DROP: "DROP permanently removes the object and its data",
  TRUNCATE: "TRUNCATE removes every row in the table",
  ALTER: "ALTER changes the table definition",
  UPDATE: "UPDATE without WHERE changes every row",
  DELETE: "DELETE without WHERE removes every row",
} as const

/**
 * Why `statement` deserves a confirmation before it runs, or null when it doesn't. Flags
 * UPDATE/DELETE without a top-level WHERE, DROP, TRUNCATE and ALTER.
 */
export function classifyDanger(statement: string): string | null {
  const masked = maskSql(statement)
  const top = topLevel(masked)
  const verb = statementVerb(masked, top)
  if (verb === "DROP" || verb === "TRUNCATE" || verb === "ALTER") return DANGER_REASONS[verb]
  if ((verb === "UPDATE" || verb === "DELETE") && !/\bWHERE\b/i.test(top)) {
    return DANGER_REASONS[verb]
  }
  return null
}
