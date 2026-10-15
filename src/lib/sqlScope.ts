/**
 * What the cursor in a SQL statement is pointing at, for completion: the word being typed, a
 * `a.b.` qualifier chain before it, the kind of name the position expects (table, column, ...)
 * and the tables the statement reads (`FROM` / `JOIN` / `UPDATE` / `INTO`, with aliases).
 *
 * This is a token-level heuristic, not a parser. It never throws and errs towards offering
 * fewer schema names rather than wrong ones.
 */

import { statementAtCursor } from "./sqlContext"
import { tokenizeSql, type SqlToken } from "./sqlTokens"

export interface TableRef {
  database: string | null
  /** Null for a derived table `(SELECT ...) t`, whose columns are unknown. */
  table: string | null
  alias: string | null
}

export interface CompletionWord {
  /** Start of the word, including an opening backtick. */
  from: number
  /** End of the range to replace: the cursor, or just past a closing backtick right after it. */
  to: number
  /** What has been typed so far, without backticks. */
  text: string
  quoted: boolean
}

/**
 * - `keyword`: only keywords fit (statement start, alias or operator position, `LIMIT`, ...).
 * - `table`: a table name (`FROM`, `JOIN`, `UPDATE`, `INTO`, ...).
 * - `column`: an expression (`SELECT` list, `WHERE`, `ON`, `ORDER BY`, function arguments).
 * - `database`: a database name (`USE`).
 * - `other`: an identifier of unknown kind.
 */
export type CursorPosition = "keyword" | "table" | "column" | "database" | "other"

export type CursorContext =
  | { kind: "none" }
  | { kind: "member"; parents: string[]; word: CompletionWord; tables: TableRef[] }
  | { kind: CursorPosition; word: CompletionWord; tables: TableRef[] }

type Clause = "table" | "column" | "database" | "keyword"

const words = (text: string) => text.split(/\s+/).filter(Boolean)

/** Keywords that open a clause, and what kind of name follows them. */
const CLAUSES: ReadonlyMap<string, Clause> = new Map<string, Clause>([
  ...words("from join straight_join update into table describe truncate").map(
    (w) => [w, "table"] as const,
  ),
  ["use", "database"],
  ...words(
    `select where on by having set using and or xor not when then else case distinct like in is
    between regexp rlike exists interval binary all any some div mod`,
  ).map((w) => [w, "column"] as const),
  ...words("limit offset as values").map((w) => [w, "keyword"] as const),
])

/** Keywords that introduce a table reference (and, after `FROM`/`UPDATE`, a comma list). */
const TABLE_INTRO = new Set(words("from join straight_join update into table describe truncate"))

/** Keywords whose comma-separated table list may continue after `JOIN ... ON ...`. */
const TABLE_LIST_START = new Set(["from", "update"])
/** Keywords that end a `FROM` / `UPDATE` table list. */
const TABLE_LIST_END = new Set(
  words("where group having order limit union except intersect window for lock into set values"),
)

/** Words that can follow a table reference, so are never a table name or alias. */
const NOT_A_NAME = new Set([
  ...CLAUSES.keys(),
  ...words(
    `left right inner outer cross natural full group order union except intersect window for lock
    partition force ignore index key procedure lateral returning with low_priority quick delayed
    high_priority limit select straight_join tablesample`,
  ),
])

const NONE: CursorContext = { kind: "none" }

const isPunct = (token: SqlToken | undefined, value: string) =>
  token?.kind === "punct" && token.value === value

const lower = (token: SqlToken | undefined) =>
  token?.kind === "word" ? token.value.toLowerCase() : null

function isName(token: SqlToken | undefined): token is SqlToken {
  if (!token) return false
  if (token.kind === "quoted") return true
  return token.kind === "word" && !NOT_A_NAME.has(token.value.toLowerCase())
}

/** Whether the cursor sits inside a comment or string literal. */
function insideOpaque(token: SqlToken, cursor: number): boolean {
  if (token.kind !== "comment" && token.kind !== "string") return false
  return token.from < cursor && (cursor < token.to || !token.closed)
}

interface Located {
  word: CompletionWord
  /** Index of the word token, or of the first token after the cursor when there is no word. */
  index: number
}

function locateWord(sql: string, tokens: SqlToken[], cursor: number): Located {
  const index = tokens.findIndex(
    (t) =>
      (t.kind === "word" && t.from < cursor && cursor <= t.to) ||
      (t.kind === "quoted" && t.from < cursor && (cursor < t.to || !t.closed)),
  )
  const token = tokens[index]
  if (!token) {
    const after = tokens.findIndex((t) => t.from >= cursor)
    return {
      word: { from: cursor, to: cursor, text: "", quoted: false },
      index: after === -1 ? tokens.length : after,
    }
  }
  if (token.kind === "word") {
    return {
      word: { from: token.from, to: cursor, text: sql.slice(token.from, cursor), quoted: false },
      index,
    }
  }
  const closingNext = token.closed && cursor === token.to - 1
  return {
    word: {
      from: token.from,
      to: closingNext ? token.to : cursor,
      text: sql.slice(token.from + 1, cursor).replaceAll("``", "`"),
      quoted: true,
    },
    index,
  }
}

/** `a.b.` before the word, outermost first; null when the word isn't qualified. */
function qualifierChain(tokens: SqlToken[], index: number): string[] | null {
  const parents: string[] = []
  let i = index - 1
  while (isPunct(tokens[i], ".")) {
    const name = tokens[i - 1]
    if (!name || (name.kind !== "word" && name.kind !== "quoted")) break
    parents.unshift(name.value)
    i -= 2
  }
  return isPunct(tokens[index - 1], ".") ? parents : null
}

interface Level {
  start: number
  /** Exclusive. */
  end: number
}

interface Item {
  kind: "token" | "group"
  first: number
  /** For a group, the index of its `)` (or the level end when unclosed). */
  last: number
}

/** Index of the `)` matching the `(` at `open`, or `end` when it is not closed before `end`. */
function matchingClose(tokens: SqlToken[], open: number, end: number): number {
  let depth = 0
  for (let i = open; i < end; i += 1) {
    if (isPunct(tokens[i], "(")) depth += 1
    else if (isPunct(tokens[i], ")")) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return end
}

/** The query blocks around the cursor, innermost first, ending with the whole statement. */
function queryLevels(tokens: SqlToken[], index: number): Level[] {
  const open: number[] = []
  for (let i = 0; i < index; i += 1) {
    if (isPunct(tokens[i], "(")) open.push(i)
    else if (isPunct(tokens[i], ")")) open.pop()
  }
  const subqueries = open
    .filter((o) => {
      const first = lower(tokens[o + 1])
      return first === "select" || first === "with"
    })
    .reverse()
    .map((o) => ({ start: o + 1, end: matchingClose(tokens, o, tokens.length) }))
  return [...subqueries, { start: 0, end: tokens.length }]
}

/** Tokens of a level with every nested parenthesis group collapsed into one item. */
function levelItems(tokens: SqlToken[], level: Level): Item[] {
  const items: Item[] = []
  let i = level.start
  while (i < level.end) {
    if (isPunct(tokens[i], "(")) {
      const close = matchingClose(tokens, i, level.end)
      items.push({ kind: "group", first: i, last: close })
      i = close + 1
    } else {
      items.push({ kind: "token", first: i, last: i })
      i += 1
    }
  }
  return items
}

/** Table references of one query level, in order. */
function tableRefs(tokens: SqlToken[], items: Item[]): TableRef[] {
  const tokenAt = (k: number) => (items[k]?.kind === "token" ? tokens[items[k].first] : undefined)

  const readRef = (j: number): { ref: TableRef | null; next: number } | null => {
    const item = items[j]
    if (!item) return null
    let database: string | null = null
    let table: string | null = null
    let next = j + 1
    if (item.kind === "token") {
      const first = tokenAt(j)
      if (!isName(first)) return null
      const second = tokenAt(j + 2)
      if (isPunct(tokenAt(j + 1), ".")) {
        if (!isName(second)) return { ref: null, next: j + 2 }
        database = first.value
        table = second.value
        next = j + 3
      } else {
        table = first.value
      }
    }
    let alias: string | null = null
    const after = tokenAt(next)
    if (lower(after) === "as") {
      const name = tokenAt(next + 1)
      if (isName(name)) {
        alias = name.value
        next += 2
      } else next += 1
    } else if (isName(after)) {
      alias = after.value
      next += 1
    }
    return { ref: { database, table, alias }, next }
  }

  const refs: TableRef[] = []
  /** Inside a `FROM` / `UPDATE` table list, where a top-level comma starts another table. */
  let inTableList = false
  let i = 0
  while (i < items.length) {
    const word = lower(tokenAt(i)) ?? ""
    const listComma = inTableList && isPunct(tokenAt(i), ",")
    if (TABLE_LIST_END.has(word)) inTableList = false
    if (!TABLE_INTRO.has(word) && !listComma) {
      i += 1
      continue
    }
    if (TABLE_LIST_START.has(word)) inTableList = true
    let j = i + 1
    for (;;) {
      const read = readRef(j)
      if (!read) break
      if (read.ref) refs.push(read.ref)
      j = read.next
      if (!isPunct(tokenAt(j), ",")) break
      j += 1
    }
    i = Math.max(j, i + 1)
  }
  return refs
}

/** In an expression: does the previous token want an operand (column) or is it complete? */
function operandPosition(tokens: SqlToken[], index: number): CursorPosition {
  const prev = tokens[index - 1]
  if (!prev) return "column"
  if (prev.kind === "punct") return prev.value === ")" ? "keyword" : "column"
  if (prev.kind === "operator") {
    if (prev.value !== "*") return "column"
    // `SELECT *`, `t.*`, `count(*)`: a star after these is complete, not multiplication.
    const before = tokens[index - 2]
    const starIsComplete =
      !before ||
      isPunct(before, ",") ||
      isPunct(before, ".") ||
      isPunct(before, "(") ||
      CLAUSES.has(lower(before) ?? "")
    return starIsComplete ? "keyword" : "column"
  }
  if (prev.kind === "word" && CLAUSES.get(prev.value.toLowerCase()) === "column") return "column"
  return "keyword"
}

function lastWhere<T>(list: readonly T[], test: (value: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (test(list[i] as T)) return list[i]
  }
  return undefined
}

function positionKind(tokens: SqlToken[], index: number, level: Level): CursorPosition {
  const items = levelItems(tokens, level)
  const containing = items.find((it) => it.kind === "group" && it.first < index && index <= it.last)
  const before = items.filter((it) => it.last < index && it !== containing)
  const clauseItem = lastWhere(
    before,
    (it) => it.kind === "token" && CLAUSES.has(lower(tokens[it.first]) ?? ""),
  )
  const clause = clauseItem ? CLAUSES.get(lower(tokens[clauseItem.first]) ?? "") : undefined
  const lastItem = before[before.length - 1]

  if (containing) {
    if (clause === "column") return operandPosition(tokens, index)
    // `INSERT INTO t (|`: a column list right after a table name.
    if (clause === "table" && lastItem?.kind === "token" && isName(tokens[lastItem.first])) {
      return isPunct(tokens[index - 1], "(") || isPunct(tokens[index - 1], ",")
        ? "column"
        : "keyword"
    }
    return "keyword"
  }
  if (!clause) return before.length === 0 ? "keyword" : "other"
  if (clause === "column") return operandPosition(tokens, index)
  if (clause === "keyword") return "keyword"
  const prevToken = tokens[index - 1]
  const rightAfterClause = lastItem === clauseItem
  if (clause === "database") return rightAfterClause ? "database" : "keyword"
  return rightAfterClause || isPunct(prevToken, ",") ? "table" : "keyword"
}

/** Context at `cursor` (an offset into `sql`), with `sql` holding a single statement. */
export function analyzeStatement(sql: string, cursor: number): CursorContext {
  const all = tokenizeSql(sql)
  if (all.some((t) => insideOpaque(t, cursor))) return NONE
  const tokens = all.filter((t) => t.kind !== "comment")
  const { word, index } = locateWord(sql, tokens, cursor)
  const levels = queryLevels(tokens, index)
  const tables = levels.flatMap((level) => tableRefs(tokens, levelItems(tokens, level)))
  const parents = qualifierChain(tokens, index)
  if (parents) return { kind: "member", parents, word, tables }
  return { kind: positionKind(tokens, index, levels[0] as Level), word, tables }
}

const shiftWord = (word: CompletionWord, by: number): CompletionWord => ({
  ...word,
  from: word.from + by,
  to: word.to + by,
})

/**
 * Context at `pos` in a whole editor document, limited to the statement around the cursor.
 * Word offsets are document offsets.
 */
export function cursorContext(doc: string, pos: number): CursorContext {
  const range = statementAtCursor(doc, pos)
  if (!range) return analyzeStatement(doc, pos)
  const startsNewStatement = range.text.endsWith(";") && pos >= range.to
  if (pos < range.from || startsNewStatement) {
    const before = analyzeStatement(doc.slice(0, pos), pos)
    if (before.kind === "none") return NONE
    return { kind: "keyword", word: { from: pos, to: pos, text: "", quoted: false }, tables: [] }
  }
  const text = doc.slice(range.from, Math.max(range.to, pos))
  const context = analyzeStatement(text, pos - range.from)
  if (context.kind === "none") return context
  return { ...context, word: shiftWord(context.word, range.from) }
}
