/**
 * Statement splitting for the query editor. Mirrors the backend rule: split on `;` outside
 * strings, quoted identifiers and comments. A `/*! ... *\/` executable comment is code (MySQL
 * runs its body) but, like a comment, never splits on a `;` inside it. `DELIMITER` blocks are
 * not supported.
 */

/**
 * Quoting rules that differ between engines. MySQL (the default) reads `"..."` as a string with
 * backslash escapes; with `ansiQuotes` (Athena / Trino) `"..."` is an identifier where only a
 * doubled `""` escapes the quote.
 */
export interface SqlSyntax {
  ansiQuotes?: boolean
}

export const MYSQL_SYNTAX: SqlSyntax = Object.freeze({})
export const ANSI_SYNTAX: SqlSyntax = Object.freeze({ ansiQuotes: true })

/** Whether `quote` opens an identifier (not a string literal) under `syntax`. */
export function isIdentifierQuote(quote: string | undefined, syntax: SqlSyntax): boolean {
  return quote === "`" || (quote === '"' && syntax.ansiQuotes === true)
}

export interface StatementRange {
  /** Offset of the first code character (leading whitespace and comments excluded). */
  from: number
  /** Offset just past the last code character, including the terminating `;`. */
  to: number
  text: string
}

interface Segment {
  start: number
  end: number
  codeFrom: number
  codeTo: number
}

const QUOTES = new Set(["'", '"', "`"])

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch)
}

/**
 * What may follow `--` for it to start a comment: ASCII whitespace or the end of the text,
 * exactly like the backend splitter (Rust `is_ascii_whitespace`: space, tab, LF, FF, CR).
 * Unicode spaces such as U+3000 don't count, so `--\u3000; DROP ...` splits at the `;` here
 * just as it does in the backend, and the editor never shows fewer statements than will run.
 */
const LINE_COMMENT_GAP = /^[ \t\n\f\r]$/

function startsLineComment(sql: string, i: number): boolean {
  if (sql[i] !== "-" || sql[i + 1] !== "-") return false
  const after = sql[i + 2]
  return after === undefined || LINE_COMMENT_GAP.test(after)
}

/**
 * Replaces comments with spaces and the inside of string literals with nothing, in one pass so
 * a quote inside a comment or a comment marker inside a string can't confuse the other.
 * Backtick identifiers are kept as they are.
 */
export function blankStringsAndComments(sql: string): string {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    const executable = executableComment(sql, i)
    if (executable) {
      out += ` ${blankStringsAndComments(sql.slice(executable.bodyFrom, executable.bodyTo))} `
      i = executable.end
      continue
    }
    const commentEnd = skipComment(sql, i)
    if (commentEnd !== -1) {
      out += " "
      i = commentEnd
      continue
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(sql, i)
      out += ch + ch
      i = end
      continue
    }
    if (ch === "`") {
      const end = skipQuoted(sql, i)
      out += sql.slice(i, end)
      i = end
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Index just past the end of a quoted run starting at `start`. A backslash escapes the next
 * character in string literals only, never in identifiers.
 */
export function skipQuoted(sql: string, start: number, syntax: SqlSyntax = MYSQL_SYNTAX): number {
  const quote = sql[start]
  const backslashEscapes = !isIdentifierQuote(quote, syntax)
  let i = start + 1
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "\\" && backslashEscapes) {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i += 1
  }
  return sql.length
}

/** Bounds of a `/*!NNNNN body *\/` executable comment: the body sits between the markers. */
export interface ExecutableComment {
  bodyFrom: number
  bodyTo: number
  /** Index just past the closing `*\/` (the end of the text when unterminated). */
  end: number
}

const VERSION_PREFIX = /^\d{5}\d?/

/** The executable comment starting at `i`, or null if none starts there. */
export function executableComment(sql: string, i: number): ExecutableComment | null {
  if (sql[i] !== "/" || sql[i + 1] !== "*" || sql[i + 2] !== "!") return null
  const version = VERSION_PREFIX.exec(sql.slice(i + 3, i + 9))
  const bodyFrom = i + 3 + (version ? version[0].length : 0)
  const close = sql.indexOf("*/", bodyFrom)
  if (close === -1) return { bodyFrom, bodyTo: sql.length, end: sql.length }
  return { bodyFrom, bodyTo: close, end: close + 2 }
}

/**
 * Returns the index just past a comment starting at `i`, or -1 if none starts there. An
 * executable comment (`/*! ... *\/`) is code, not a comment; see `executableComment`.
 */
export function skipComment(sql: string, i: number): number {
  const ch = sql[i]
  const next = sql[i + 1]
  const lineComment = ch === "#" || startsLineComment(sql, i)
  if (lineComment) {
    const newline = sql.indexOf("\n", i)
    return newline === -1 ? sql.length : newline
  }
  if (ch === "/" && next === "*" && sql[i + 2] !== "!") {
    const close = sql.indexOf("*/", i + 2)
    return close === -1 ? sql.length : close + 2
  }
  return -1
}

function scanSegments(sql: string, syntax: SqlSyntax): Segment[] {
  const segments: Segment[] = []
  let start = 0
  let codeFrom = -1
  let codeTo = -1
  let i = 0
  const markCode = (from: number, to: number) => {
    if (codeFrom === -1) codeFrom = from
    codeTo = to
  }
  while (i < sql.length) {
    const ch = sql[i]
    const executable = executableComment(sql, i)
    const commentEnd = skipComment(sql, i)
    if (executable) {
      markCode(i, executable.end)
      i = executable.end
    } else if (commentEnd !== -1) {
      i = commentEnd
    } else if (QUOTES.has(ch)) {
      const end = skipQuoted(sql, i, syntax)
      markCode(i, end)
      i = end
    } else if (ch === ";") {
      markCode(i, i + 1)
      segments.push({ start, end: i + 1, codeFrom, codeTo })
      start = i + 1
      codeFrom = -1
      codeTo = -1
      i += 1
    } else {
      if (!isWhitespace(ch)) markCode(i, i + 1)
      i += 1
    }
  }
  if (start < sql.length || segments.length === 0) {
    segments.push({ start, end: sql.length, codeFrom, codeTo })
  }
  return segments
}

/** A segment holding only `;` (or nothing) carries no statement. */
function hasStatement(sql: string, segment: Segment): boolean {
  if (segment.codeFrom === -1) return false
  return sql.slice(segment.codeFrom, segment.codeTo) !== ";"
}

function toRange(sql: string, segment: Segment): StatementRange {
  return {
    from: segment.codeFrom,
    to: segment.codeTo,
    text: sql.slice(segment.codeFrom, segment.codeTo),
  }
}

/** Every non-empty statement in `sql`, in order. */
export function splitStatements(sql: string, syntax: SqlSyntax = MYSQL_SYNTAX): StatementRange[] {
  return scanSegments(sql, syntax)
    .filter((segment) => hasStatement(sql, segment))
    .map((segment) => toRange(sql, segment))
}

/**
 * The statement the cursor belongs to. A cursor in the gap after a `;` on the same line still
 * selects the statement that just ended; a cursor on a later blank line selects the next one.
 * Falls back to the nearest previous statement, then the next one.
 */
export function statementAtCursor(
  sql: string,
  cursor: number,
  syntax: SqlSyntax = MYSQL_SYNTAX,
): StatementRange | null {
  const pos = Math.max(0, Math.min(cursor, sql.length))
  const segments = scanSegments(sql, syntax)
  const index = Math.max(
    0,
    segments.findIndex((s) => pos >= s.start && pos < s.end),
  )
  const containing = pos === sql.length ? segments.length - 1 : index
  const segment = segments[containing]
  const previous = segments
    .slice(0, containing)
    .reverse()
    .find((s) => hasStatement(sql, s))

  if (hasStatement(sql, segment)) {
    const inLeadingGap = pos < segment.codeFrom
    const sameLineAsPrevious = !sql.slice(segment.start, pos).includes("\n")
    if (inLeadingGap && sameLineAsPrevious && previous && containing > 0) {
      return toRange(sql, previous)
    }
    return toRange(sql, segment)
  }
  if (previous) return toRange(sql, previous)
  const next = segments.slice(containing + 1).find((s) => hasStatement(sql, s))
  return next ? toRange(sql, next) : null
}
