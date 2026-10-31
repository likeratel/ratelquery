import type { Item, PathSegment } from "./dynamo"
import { attributeTag } from "./dynamoJson"
import { parsePath, pathKey } from "./dynamoPath"
import {
  isExpanded,
  isTable,
  revealInTree,
  tableColumns,
  treeNode,
  type TreeExpansion,
  type TreeValue,
} from "./dynamoTree"

/**
 * Find in the item panel's tree: an index of every row (keys and leaf text, at every depth and
 * inside JSON stored in strings), matched as text or, when the query reads as a document path,
 * as that path.
 */

/** One row of the item tree, in the order the tree shows them. */
export interface FindEntry {
  path: readonly PathSegment[]
  /** Map key, JSON object key or attribute name; null for list items and set members. */
  key: string | null
  /** Leaf text as the tree shows it, untruncated; null for containers and binary values. */
  text: string | null
}

/** Line breaks and tabs show as one space in the tree, as in the grid. */
const flat = (text: string) => text.replace(/[\r\n\t]+/g, " ")

function leafText(value: TreeValue, shown: string): string | null {
  if (value.kind === "json") return typeof value.value === "string" ? flat(value.value) : shown
  const tag = attributeTag(value.value)
  // Binary shows as "(binary, n bytes)", which isn't its value.
  if (tag === "B") return null
  if (tag === "S") return flat(String(value.value.S))
  // N keeps its exact text, BOOL reads true / false and NULL reads NULL, as shown.
  return shown
}

function walk(value: TreeValue, path: PathSegment[], key: string | null, out: FindEntry[]) {
  const node = treeNode(value)
  out.push({ path, key, text: node.children ? null : leafText(value, node.text) })
  for (const child of node.children ?? []) {
    const segment = child.segment
    // Set members are numbered like list items, but their segment is never a map key.
    const childKey = typeof segment === "string" ? segment : null
    walk(child.value, [...path, segment], childKey, out)
  }
}

const indexes = new WeakMap<Item, { order: string; entries: readonly FindEntry[] }>()

/**
 * Every row of `item` in document order: the attributes in `names` order (the tree's order),
 * each followed by its members. Kept per item object, so typing a query never walks the item.
 */
export function findIndex(item: Item, names: readonly string[]): readonly FindEntry[] {
  const order = JSON.stringify(names)
  const cached = indexes.get(item)
  if (cached?.order === order) return cached.entries
  const entries: FindEntry[] = []
  for (const name of names) {
    const value = item[name]
    if (value) walk({ kind: "wire", value }, [name], name, entries)
  }
  indexes.set(item, { order, entries })
  return entries
}

export interface FindOptions {
  caseSensitive: boolean
  /** Match attribute names and map keys. */
  keys: boolean
  /** Match leaf values. */
  values: boolean
}

export const DEFAULT_FIND_OPTIONS: FindOptions = { caseSensitive: false, keys: true, values: true }

/** Start and end of a matched substring. */
export type FindRange = readonly [number, number]

export interface FindHit {
  path: readonly PathSegment[]
  key: readonly FindRange[]
  value: readonly FindRange[]
}

export interface FindResult {
  /** `path` when the query read as a document path that leads to rows. */
  via: "text" | "path"
  hits: readonly FindHit[]
  /** With `via: "path"`: how many rows the same query matches as text (quote it to see them). */
  asText: number
}

export const NO_FIND_RESULT: FindResult = { via: "text", hits: [], asText: 0 }

const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")

/**
 * A matcher for `query`. It runs on the original text (with Unicode case folding when case
 * doesn't matter), so offsets never drift the way they would on a lowercased copy: `İ` lowers to
 * two code units, and an emoji is never split.
 */
function matcher(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(escapeRegExp(query), caseSensitive ? "gu" : "giu")
}

function rangesOf(text: string, pattern: RegExp): FindRange[] {
  const ranges: FindRange[] = []
  for (const match of text.matchAll(pattern)) {
    if (match[0] !== "") ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

/** Where `query` occurs in `text`, without overlaps, as offsets into `text` itself. */
export function textRanges(text: string, query: string, caseSensitive: boolean): FindRange[] {
  if (query === "") return []
  return rangesOf(text, matcher(query, caseSensitive))
}

/** The text inside quotes, when the whole (trimmed) query is quoted: a search for it as text. */
function quotedText(query: string): string | null {
  const text = query.trim()
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : null
}

/**
 * The document path `query` spells, when it reads as one: a name followed by `.name`, `[0]` or
 * `["quoted"]` as the tree's Copy path writes it. A bare word, or a query wrapped in double
 * quotes, is a text search, not a path.
 */
export function queryPath(query: string): PathSegment[] | null {
  const text = query.trim()
  if (!/[.[]/.test(text) || quotedText(text) !== null) return null
  return parsePath(text)
}

/** The text a query searches for: what is inside the quotes of a quoted query, else itself. */
export function queryText(query: string): string {
  return quotedText(query) ?? query
}

function endsWith(path: readonly PathSegment[], suffix: readonly PathSegment[]): boolean {
  const offset = path.length - suffix.length
  return offset >= 0 && suffix.every((segment, i) => path[offset + i] === segment)
}

/**
 * Rows `path` leads to: the row at that path from the top, else every row whose path ends with
 * it (`numbers[0].senderStatus` finds `senderService.numbers[0].senderStatus`).
 */
export function resolvePath(
  entries: readonly FindEntry[],
  path: readonly PathSegment[],
): FindEntry[] {
  const key = pathKey(path)
  const exact = entries.filter((entry) => pathKey(entry.path) === key)
  if (exact.length > 0) return exact
  return entries.filter((entry) => entry.path.length > path.length && endsWith(entry.path, path))
}

function textHits(entries: readonly FindEntry[], text: string, options: FindOptions): FindHit[] {
  // Only an empty text finds nothing; a quoted run of spaces is searched for as it is.
  if (text === "") return []
  const pattern = matcher(text, options.caseSensitive)
  const hits: FindHit[] = []
  for (const entry of entries) {
    const key = options.keys && entry.key !== null ? rangesOf(entry.key, pattern) : []
    const value = options.values && entry.text !== null ? rangesOf(entry.text, pattern) : []
    if (key.length > 0 || value.length > 0) hits.push({ path: entry.path, key, value })
  }
  return hits
}

/**
 * The rows matching `query`, in document order. A query that reads as a path and leads to rows
 * jumps to them (counting its text matches too, in `asText`); otherwise, or when the query is
 * wrapped in double quotes, keys and leaf text are searched as substrings.
 */
export function findInItem(
  entries: readonly FindEntry[],
  query: string,
  options: FindOptions,
): FindResult {
  if (query.trim() === "") return NO_FIND_RESULT
  const path = queryPath(query)
  const target = path ? resolvePath(entries, path) : []
  const text = textHits(entries, queryText(query), options)
  if (target.length > 0) {
    const hits = target.map((entry) => ({ path: entry.path, key: [], value: [] }))
    return { via: "path", hits, asText: text.length }
  }
  return { via: "text", hits: text, asText: text.length }
}

/** The query that searches `query` as text: wrapped in double quotes, exactly as typed. */
export function asTextQuery(query: string): string {
  return `"${query}"`
}

/**
 * What the JSON view's search starts with for the tree's query: the text the tree searches for,
 * or, when the tree jumps to a path (it reads as one and `resolves` it), the last key on it,
 * since JSON shows keys, not paths.
 */
export function jsonSearchText(
  query: string,
  resolves: (path: readonly PathSegment[]) => boolean,
): string {
  if (query.trim() === "") return ""
  const path = queryPath(query)
  if (path && resolves(path)) {
    const key = path.findLast((segment) => typeof segment === "string")
    if (key !== undefined) return String(key)
  }
  return queryText(query)
}

/** A value tied to one search (query and toggles). */
export interface Scoped<T> {
  search: string
  value: T
}

/**
 * `stored` while it belongs to `search`, else a fresh `initial` for it. Callers store what this
 * returns, so going back to an earlier query starts afresh rather than reviving its state.
 */
export function rescope<T>(stored: Scoped<T>, search: string, initial: T): Scoped<T> {
  return stored.search === search ? stored : { search, value: initial }
}

/**
 * Ranges inside the part of a value the tree shows (`limit` characters, before the `…` of a
 * shortened value), and how many matches lie past it.
 */
export function visibleRanges(
  ranges: readonly FindRange[],
  limit: number,
): { shown: FindRange[]; hidden: number } {
  const shown: FindRange[] = []
  let hidden = 0
  for (const [start, end] of ranges) {
    if (start >= limit) hidden += 1
    else shown.push([start, Math.min(end, limit)])
  }
  return { shown, hidden }
}

/** Keys of the rows above `paths`, which open so every one of them shows. */
export function ancestorKeys(paths: Iterable<readonly PathSegment[]>): Set<string> {
  const keys = new Set<string>()
  for (const path of paths) {
    for (let depth = 1; depth < path.length; depth += 1) keys.add(pathKey(path.slice(0, depth)))
  }
  return keys
}

/** What filter mode shows: the given rows, the rows above them, and everything inside them. */
export interface FindFilter {
  /** The rows themselves and their ancestors. */
  shown: ReadonlySet<string>
  /** The rows themselves; their members show as usual. */
  whole: ReadonlySet<string>
}

export function findFilter(paths: readonly (readonly PathSegment[])[]): FindFilter {
  const whole = new Set(paths.map(pathKey))
  return { shown: new Set([...whole, ...ancestorKeys(paths)]), whole }
}

/** Whether filter mode shows the row at `path`. */
export function filterShows(filter: FindFilter, path: readonly PathSegment[]): boolean {
  if (filter.shown.has(pathKey(path))) return true
  for (let depth = 1; depth < path.length; depth += 1) {
    if (filter.whole.has(pathKey(path.slice(0, depth)))) return true
  }
  return false
}

/** Rows of the table of the list at `listPath` that filter mode shows. */
export function filterTableRows<T extends { segment: PathSegment }>(
  filter: FindFilter,
  listPath: readonly PathSegment[],
  rows: readonly T[],
): T[] {
  return rows.filter((row) => filterShows(filter, [...listPath, row.segment]))
}

/**
 * Opening, closing and table toggles made while a search shows. They stay out of the user's
 * own expansion and are dropped with the search, so clearing it returns the tree exactly.
 */
export interface SearchOverlay {
  /** Set by Expand all / Collapse all during the search. */
  base: TreeExpansion["base"] | null
  open: Readonly<Record<string, boolean>>
  tables: Readonly<Record<string, boolean>>
}

export const EMPTY_OVERLAY: SearchOverlay = { base: null, open: {}, tables: {} }

/** Most matches whose rows are opened at once; past it only the current match is opened. */
export const REVEAL_LIMIT = 500

/**
 * Rows to open so matches show: the rows above every match, or above the current one alone
 * when there are more than `limit` (a short query on a large item would open nearly all of it).
 */
export function revealKeys(
  paths: readonly (readonly PathSegment[])[],
  current: readonly PathSegment[] | null,
  limit = REVEAL_LIMIT,
): Set<string> {
  return ancestorKeys(paths.length <= limit ? paths : current ? [current] : [])
}

/**
 * The tree's expansion while a search shows: the user's own with the rows above matches open,
 * then the overlay's changes. After Expand all / Collapse all in the search only the current
 * match (`focus`) is kept open on top. The user's expansion is never changed.
 */
export function searchExpansion(
  user: TreeExpansion,
  reveal: ReadonlySet<string>,
  overlay: SearchOverlay,
  focus: ReadonlySet<string> = new Set(),
): TreeExpansion {
  if (reveal.size === 0 && focus.size === 0 && overlay === EMPTY_OVERLAY) return user
  const open: Record<string, boolean> = overlay.base ? {} : { ...user.open }
  for (const key of overlay.base ? focus : [...reveal, ...focus]) open[key] = true
  return {
    base: overlay.base ?? user.base,
    open: { ...open, ...overlay.open },
    tables: { ...user.tables, ...overlay.tables },
  }
}

/** Opens or closes the node at `path` for the rest of the search. */
export function overlayToggle(
  overlay: SearchOverlay,
  shown: TreeExpansion,
  path: readonly PathSegment[],
  holdsJson: boolean,
): SearchOverlay {
  const open = !isExpanded(shown, path, holdsJson)
  return { ...overlay, open: { ...overlay.open, [pathKey(path)]: open } }
}

/** Expand all / Collapse all for the rest of the search. */
export function overlaySetAll(overlay: SearchOverlay, open: boolean): SearchOverlay {
  return { ...overlay, base: open ? "all" : "none", open: {} }
}

/** Shows the list at `path` as a table, or as a tree, for the rest of the search. */
export function overlayToggleTable(
  overlay: SearchOverlay,
  shown: TreeExpansion,
  path: readonly PathSegment[],
): SearchOverlay {
  const key = pathKey(path)
  return { ...overlay, tables: { ...overlay.tables, [key]: !isTable(shown, path) } }
}

/** Follows a nested table cell into the tree for the rest of the search (see `revealInTree`). */
export function overlayReveal(
  overlay: SearchOverlay,
  path: readonly PathSegment[],
  target: readonly PathSegment[],
): SearchOverlay {
  const revealed = revealInTree({ base: "first", open: {}, tables: {} }, path, target)
  return {
    ...overlay,
    open: { ...overlay.open, ...revealed.open },
    tables: { ...overlay.tables, ...revealed.tables },
  }
}

/** The value at `path` in the tree, walking maps, lists, sets and JSON stored in strings. */
function treeValueAt(item: Item, path: readonly PathSegment[]): TreeValue | undefined {
  const [name, ...rest] = path
  const first = typeof name === "string" ? item[name] : undefined
  let value: TreeValue | undefined = first ? { kind: "wire", value: first } : undefined
  for (const segment of rest) {
    if (!value) return undefined
    value = treeNode(value).children?.find((child) => child.segment === segment)?.value
  }
  return value
}

/**
 * Hits in the order the tree shows them: document order, except that in a list shown as a table
 * a row's cells follow the table's columns, so stepping goes left to right.
 */
export function orderHits(
  hits: readonly FindHit[],
  item: Item,
  isTableAt: (path: readonly PathSegment[]) => boolean,
): readonly FindHit[] {
  const columns = new Map<string, readonly string[] | null>()
  const columnsAt = (listPath: readonly PathSegment[]) => {
    const key = pathKey(listPath)
    if (!columns.has(key)) {
      const value = isTableAt(listPath) ? treeValueAt(item, listPath) : undefined
      const children = value ? treeNode(value).children : null
      columns.set(key, children ? tableColumns(children) : null)
    }
    return columns.get(key) ?? null
  }
  const position = new Map(hits.map((hit, i) => [hit, i]))
  const compare = (a: FindHit, b: FindHit) => {
    const depth = a.path.findIndex((segment, i) => segment !== b.path[i])
    if (depth >= 2 && depth < b.path.length) {
      const [x, y] = [a.path[depth], b.path[depth]]
      const table =
        typeof x === "string" && typeof y === "string" && columnsAt(a.path.slice(0, depth - 1))
      if (table) return table.indexOf(x) - table.indexOf(y)
    }
    return (position.get(a) ?? 0) - (position.get(b) ?? 0)
  }
  // Only hits inside table rows can move; most searches keep their order and their array.
  const moved = [...hits].sort(compare)
  return moved.every((hit, i) => hit === hits[i]) ? hits : moved
}

/** The match after (1) or before (-1) `current`, wrapping around at either end. */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return 0
  return (((current + direction) % count) + count) % count
}

/** The find bar's query and whether it shows. */
export interface FindBarState {
  open: boolean
  query: string
}

/** Esc in the find bar: clears the query, then closes the bar. */
export function escapeFind(state: FindBarState): FindBarState {
  return state.query !== "" ? { ...state, query: "" } : { open: false, query: "" }
}

/** Positions of hits by row key, for the rows to look themselves up while rendering. */
export function hitPositions(result: FindResult): Map<string, number> {
  return new Map(result.hits.map((hit, i) => [pathKey(hit.path), i]))
}
