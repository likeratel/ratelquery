/**
 * A small MySQL tokenizer for editor features that need offsets (completion). It follows the same
 * comment and quoting rules as the statement splitter in `sqlContext`: `--` starts a comment only
 * before ASCII whitespace, `#` and `/* *\/` are comments, and the body of a `/*! ... *\/`
 * executable comment is code.
 */

import { executableComment, skipComment } from "./sqlContext"

export type SqlTokenKind =
  /** Bare word: identifier or keyword. */
  | "word"
  /** Backtick identifier. */
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
  /** Source text for most tokens; the identifier name (without backticks) for `quoted`. */
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

/** Index just past a backtick identifier starting at `start`; `` `` `` inside is an escaped backtick. */
function scanBacktick(sql: string, start: number): { end: number; closed: boolean } {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === "`") {
      if (sql[i + 1] === "`") {
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

/** Tokens of `sql` in order, comments included. Whitespace is dropped. */
export function tokenizeSql(sql: string): SqlToken[] {
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
    if (ch === "`") {
      const { end, closed } = scanBacktick(sql, i)
      const inner = sql.slice(i + 1, closed ? end - 1 : end)
      push("quoted", i, end, inner.replaceAll("``", "`"), closed)
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
