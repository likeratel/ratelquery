/**
 * A small MySQL tokenizer for editor features that need offsets (completion). It follows the same
 * comment and quoting rules as the statement splitter in `sqlContext`: `--` starts a comment only
 * before ASCII whitespace, `#` and `/* *\/` are comments, and the body of a `/*! ... *\/`
 * executable comment is code. With `ANSI_SYNTAX` (Athena) `"..."` is an identifier, like a
 * backtick one in MySQL.
 */

import {
  executableComment,
  isIdentifierQuote,
  MYSQL_SYNTAX,
  skipComment,
  type SqlSyntax,
} from "./sqlContext"

export type SqlTokenKind =
  /** Bare word: identifier or keyword. */
  | "word"
  /** Quoted identifier: backticks, or double quotes with `ANSI_SYNTAX`. */
  | "quoted"
  | "string"
  | "number"
  | "comment"
  /** `.`, `,`, `(`, `)`, `;` */
  | "punct"
  | "operator"

export interface SqlToken {
  kind: SqlTokenKind
  from: number
  to: number
  /** Source text for most tokens; the identifier name (without its quotes) for `quoted`. */
  value: string
  /** For `quoted` and `string`: whether the closing quote is present. */
  closed: boolean
}

const PUNCT = new Set([".", ",", "(", ")", ";"])
const WORD_CHAR = /[\p{L}\p{N}_$]/u
const DIGIT = /[0-9]/

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch)
}

/**
 * Index just past a quoted identifier starting at `start`; its quote doubled inside (`` `` `` or
 * `""`) is an escaped quote.
 */
function scanIdentifier(sql: string, start: number): { end: number; closed: boolean } {
  const quote = sql[start]
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return { end: i + 1, closed: true }
    }
    i += 1
  }
  return { end: sql.length, closed: false }
}

/** Index just past a string literal; backslash escapes and doubled quotes stay inside. */
function scanString(sql: string, start: number): { end: number; closed: boolean } {
  const quote = sql[start]
  let i = start + 1
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return { end: i + 1, closed: true }
    }
    i += 1
  }
  return { end: sql.length, closed: false }
}

function scanNumber(sql: string, start: number): number {
  let i = start
  while (i < sql.length) {
    const ch = sql[i]
    if (isWordChar(ch)) i += 1
    else if (ch === "." && DIGIT.test(sql[i + 1] ?? "")) i += 1
    else break
  }
  return i
}

function scanWord(sql: string, start: number): number {
  let i = start
  while (isWordChar(sql[i])) i += 1
  return i
}

/** The name inside a quoted identifier token's text, with doubled quotes unescaped. */
export function unquotedName(text: string, closed: boolean): string {
  const quote = text[0] as string
  const inner = text.slice(1, closed ? text.length - 1 : text.length)
  return inner.replaceAll(quote + quote, quote)
}

/** Tokens of `sql` in order, comments included. Whitespace is dropped. */
export function tokenizeSql(sql: string, syntax: SqlSyntax = MYSQL_SYNTAX): SqlToken[] {
  const tokens: SqlToken[] = []
  /** Close markers (`*\/`) of executable comments we are inside, innermost last. */
  const executableEnds: number[] = []
  const push = (kind: SqlTokenKind, from: number, to: number, value: string, closed = true) =>
    tokens.push({ kind, from, to, value, closed })
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    if (executableEnds.length > 0 && i === executableEnds[executableEnds.length - 1]) {
      executableEnds.pop()
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    const executable = executableComment(sql, i)
    if (executable) {
      if (executable.bodyTo < sql.length) executableEnds.push(executable.bodyTo)
      i = executable.bodyFrom
      continue
    }
    const commentEnd = skipComment(sql, i)
    if (commentEnd !== -1) {
      const text = sql.slice(i, commentEnd)
      // A line comment runs to the end of its line, so a cursor at its end is still inside.
      const closed = text.startsWith("/*") && text.length >= 4 && text.endsWith("*/")
      push("comment", i, commentEnd, text, closed)
      i = commentEnd
      continue
    }
    if (isIdentifierQuote(ch, syntax)) {
      const { end, closed } = scanIdentifier(sql, i)
      push("quoted", i, end, unquotedName(sql.slice(i, end), closed), closed)
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      const { end, closed } = scanString(sql, i)
      push("string", i, end, sql.slice(i, end), closed)
      i = end
      continue
    }
    if (DIGIT.test(ch)) {
      const end = scanNumber(sql, i)
      const text = sql.slice(i, end)
      push(/^[0-9.]+$/.test(text) ? "number" : "word", i, end, text)
      i = end
      continue
    }
    if (isWordChar(ch)) {
      const end = scanWord(sql, i)
      push("word", i, end, sql.slice(i, end))
      i = end
      continue
    }
    push(PUNCT.has(ch) ? "punct" : "operator", i, i + 1, ch)
    i += 1
  }
  return tokens
}
