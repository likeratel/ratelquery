/**
 * Safety rewrites and checks applied before a statement runs: a default LIMIT for unbounded
 * SELECTs and a danger classification for statements that change many rows or the schema.
 * Matching runs on a masked copy (strings, quoted identifiers and comments blanked, same
 * length) so keywords inside literals or comments never count.
 */
import { executableComment, skipComment, skipQuoted } from "./sqlContext"

/**
 * Same-length copy of `sql` with comment text and the inside of quoted runs (strings and
 * backtick identifiers) replaced by spaces. Quote characters stay so tokens stay separated.
 * An executable comment (`/*!NNNNN ... *\/`) is code: only its markers become spaces.
 */
export function maskSql(sql: string): string {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const executable = executableComment(sql, i)
    if (executable) {
      const { bodyFrom, bodyTo, end } = executable
      out += " ".repeat(bodyFrom - i) + maskSql(sql.slice(bodyFrom, bodyTo))
      out += " ".repeat(end - bodyTo)
      i = end
      continue
    }
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

/** True when the whole statement is one parenthesized query, like `(SELECT ...)`. */
function isParenthesized(masked: string, end: number): boolean {
  const start = masked.search(/\S/)
  if (start === -1 || masked[start] !== "(" || masked[end - 1] !== ")") return false
  let depth = 0
  for (let i = start; i < end; i += 1) {
    const ch = masked[i]
    if (ch === "(") depth += 1
    else if (ch === ")") depth -= 1
    // The opening parenthesis closed before the end: `(SELECT ...) UNION (SELECT ...)`.
    if (depth === 0 && i < end - 1) return false
  }
  return depth === 0
}

/**
 * Adds ` LIMIT n` to a single SELECT (including UNIONs, subqueries and `WITH ... SELECT`) that
 * has no top-level LIMIT. The LIMIT goes before a locking clause (`FOR UPDATE`, `FOR SHARE`,
 * `LOCK IN SHARE MODE`) and before a trailing `;` or comment. Statements with a top-level INTO
 * (`INTO OUTFILE`, `INTO @var`) or PROCEDURE, a statement wrapped whole in parentheses, and
 * anything that is not a SELECT, including SHOW and EXPLAIN, are returned unchanged.
 */
export function withDefaultLimit(statement: string, limit: number): string {
  const masked = maskSql(statement)
  const top = topLevel(masked)
  if (statementVerb(masked, top) !== "SELECT") return statement
  if (/\b(LIMIT|INTO|PROCEDURE)\b/i.test(top)) return statement
  const end = codeEnd(masked)
  if (isParenthesized(masked, end)) return statement
  const clause = `LIMIT ${limit}`
  const locking = LOCKING_CLAUSE.exec(top.slice(0, end))
  if (locking) {
    const head = statement.slice(0, locking.index).trimEnd()
    return `${head} ${clause} ${statement.slice(locking.index)}`
  }
  return `${statement.slice(0, end)} ${clause}${statement.slice(end)}`
}

/** Objects an `ALTER` can target, named in the confirmation reason. */
const ALTER_TARGETS = new Set([
  "DATABASE",
  "EVENT",
  "FUNCTION",
  "INSTANCE",
  "LOGFILE",
  "PROCEDURE",
  "RESOURCE",
  "SCHEMA",
  "SERVER",
  "TABLE",
  "TABLESPACE",
  "UNDO",
  "USER",
  "VIEW",
])

const DANGER_REASONS = {
  DROP: "DROP permanently removes the object and its data",
  TRUNCATE: "TRUNCATE removes every row in the table",
  ALTER: "ALTER changes a definition",
  RENAME: "RENAME TABLE renames tables; anything that uses the old name stops working",
  UPDATE: "UPDATE without WHERE changes every row",
  DELETE: "DELETE without WHERE removes every row",
} as const

/** The word after the leading keyword, upper-cased (`TABLE` in `ALTER TABLE t`). */
function secondKeyword(masked: string): string {
  const match = /^[\s(]*[A-Za-z_]+\s+([A-Za-z_]+)/.exec(masked)
  return match ? (match[1] as string).toUpperCase() : ""
}

/** `ALTER TABLE changes a definition`, or the generic reason for an unknown target. */
function alterReason(masked: string): string {
  const target = secondKeyword(masked)
  return ALTER_TARGETS.has(target) ? `ALTER ${target} changes a definition` : DANGER_REASONS.ALTER
}

/**
 * Why `statement` deserves a confirmation before it runs, or null when it doesn't. Flags
 * UPDATE/DELETE without a top-level WHERE, DROP, TRUNCATE, ALTER and RENAME TABLE.
 */
export function classifyDanger(statement: string): string | null {
  const masked = maskSql(statement)
  const top = topLevel(masked)
  const verb = statementVerb(masked, top)
  if (verb === "DROP" || verb === "TRUNCATE") return DANGER_REASONS[verb]
  if (verb === "ALTER") return alterReason(masked)
  if (verb === "RENAME" && secondKeyword(masked) === "TABLE") return DANGER_REASONS.RENAME
  if ((verb === "UPDATE" || verb === "DELETE") && !/\bWHERE\b/i.test(top)) {
    return DANGER_REASONS[verb]
  }
  return null
}
