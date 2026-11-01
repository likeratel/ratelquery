import { cellTone, formatCell, type CellTone } from "./cellFormat"
import type { AttributeValue, Item, PathSegment } from "./dynamo"
import {
  attributeTag,
  findLossyAttributes,
  jsonInString,
  MAX_DOCUMENT_DEPTH,
  wireToPlain,
  type JsonInString,
  type PlainValue,
} from "./dynamoJson"
import { pathKey } from "./dynamoPath"
import { attributeToCell } from "./dynamoView"
import type { Cell } from "./mysql"

/**
 * The item panel's tree: one node per value, where maps, lists, sets and JSON stored in a string
 * open into their members. Leaf text follows the grid (NULL, booleans, binary sizes); numbers
 * keep their exact text.
 */

/** A value in the tree: a DynamoDB attribute, or a JSON value parsed out of a string. */
export type TreeValue =
  { kind: "wire"; value: AttributeValue } | { kind: "json"; value: PlainValue }

export interface TreeChild {
  segment: PathSegment
  value: TreeValue
}

export interface TreeNode {
  /** S, N, M ... for attributes; object, array, string ... for JSON. */
  tag: string
  /** Members of maps, lists, sets, JSON objects and arrays, and of an S holding JSON. */
  children: readonly TreeChild[] | null
  /** Leaf text in the grid's style, or a count such as `16 keys` for containers. */
  text: string
  tone: CellTone
  /** The JSON an S holds, when it is an object or array. */
  json: JsonInString | null
}

const wire = (value: AttributeValue): TreeValue => ({ kind: "wire", value })
const json = (value: PlainValue): TreeValue => ({ kind: "json", value })

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

function jsonChildren(value: PlainValue): TreeChild[] | null {
  if (Array.isArray(value)) return value.map((v, i) => ({ segment: i, value: json(v) }))
  if (value === null || typeof value !== "object") return null
  return Object.entries(value).map(([key, v]) => ({ segment: key, value: json(v) }))
}

function countText(children: readonly TreeChild[], keyed: boolean): string {
  return plural(children.length, keyed ? "key" : "item")
}

function wireNode(value: AttributeValue): TreeNode {
  const tag = attributeTag(value)
  const inner = tag ? value[tag] : undefined
  const container = (children: TreeChild[], keyed: boolean): TreeNode => ({
    tag: tag ?? "?",
    children,
    text: countText(children, keyed),
    tone: "json",
    json: null,
  })
  switch (tag) {
    case "M":
      return container(
        Object.entries(inner as Item).map(([key, v]) => ({ segment: key, value: wire(v) })),
        true,
      )
    case "L":
      return container(
        (inner as AttributeValue[]).map((v, i) => ({ segment: i, value: wire(v) })),
        false,
      )
    case "SS":
    case "NS":
    case "BS": {
      const member = tag.slice(0, 1)
      return container(
        (inner as string[]).map((v, i) => ({ segment: i, value: wire({ [member]: v }) })),
        false,
      )
    }
    case "S": {
      // JSON whose numbers can't be parsed exactly stays a string, so nothing shows rounded.
      const found = jsonInString(String(inner))
      const children = found?.exact ? jsonChildren(found.value) : null
      if (children) {
        const text = countText(children, !Array.isArray(found?.value))
        return { tag, children, text, tone: "json", json: found }
      }
      return { ...leaf(value), json: found }
    }
  }
  return leaf(value)
}

function leaf(value: AttributeValue): TreeNode {
  const cell = attributeToCell(value)
  const tag = attributeTag(value) ?? "?"
  return { tag, children: null, text: formatCell(cell), tone: cellTone(cell), json: null }
}

const JSON_TAGS = { string: "string", number: "number", boolean: "bool" } as const

function jsonNode(value: PlainValue): TreeNode {
  const children = jsonChildren(value)
  if (children) {
    const keyed = !Array.isArray(value)
    const tag = keyed ? "object" : "array"
    return { tag, children, text: countText(children, keyed), tone: "json", json: null }
  }
  if (value === null) return { tag: "null", children: null, text: "NULL", tone: "null", json: null }
  const tag = JSON_TAGS[typeof value as keyof typeof JSON_TAGS]
  const cell: Cell =
    typeof value === "string"
      ? { t: "str", v: value }
      : typeof value === "number"
        ? { t: "decimal", v: String(value) }
        : { t: "bool", v: Boolean(value) }
  return { tag, children: null, text: formatCell(cell), tone: cellTone(cell), json: null }
}

// Nodes by value object. Items and the JSON parsed out of their strings are never changed in
// place, so a row re-rendering, a table reading its cells, and the find index all build a
// node (and parse a string's JSON) once per value.
const wireNodes = new WeakMap<AttributeValue, TreeNode>()
const jsonNodes = new WeakMap<object, TreeNode>()

export function treeNode(value: TreeValue): TreeNode {
  if (value.kind === "wire") {
    const cached = wireNodes.get(value.value)
    if (cached) return cached
    const node = wireNode(value.value)
    wireNodes.set(value.value, node)
    return node
  }
  const v = value.value
  if (v === null || typeof v !== "object") return jsonNode(v)
  const cached = jsonNodes.get(v)
  if (cached) return cached
  const node = jsonNode(v)
  jsonNodes.set(v, node)
  return node
}

/** The text "Copy value" puts on the clipboard: leaves as they are, the rest as JSON. */
export function copyValueText(value: TreeValue): string {
  if (value.kind === "json") {
    const v = value.value
    return typeof v === "string" ? v : JSON.stringify(v, null, 2)
  }
  const tag = attributeTag(value.value)
  switch (tag) {
    case "S":
    case "N":
    case "B":
      return String(value.value[tag])
    case "BOOL":
    case "NULL":
      return JSON.stringify(wireToPlain(value.value))
    default: {
      // Containers copy as plain JSON unless that would change them, like the JSON view.
      const lossy = findLossyAttributes({ value: value.value }).length > 0
      return JSON.stringify(lossy ? value.value : wireToPlain(value.value), null, 2)
    }
  }
}

/** Keys of a map-like tree value, or null for anything else. */
function objectKeys(value: TreeValue): string[] | null {
  if (value.kind === "wire") {
    return attributeTag(value.value) === "M" ? Object.keys(value.value.M as Item) : null
  }
  const v = value.value
  return v !== null && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : null
}

/**
 * Columns for showing a list of maps as a table: the union of the keys in first-seen order.
 * Null unless there are two or more items, all maps, that share at least one key.
 */
export function tableColumns(children: readonly TreeChild[]): string[] | null {
  if (children.length < 2) return null
  const keys = children.map((child) => objectKeys(child.value))
  if (keys.some((k) => k === null)) return null
  const counts = new Map<string, number>()
  for (const key of (keys as string[][]).flat()) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts.values()].some((n) => n > 1) ? [...counts.keys()] : null
}

/** The member `key` of a map-like tree value, if it has one. */
export function memberOf(value: TreeValue, key: string): TreeValue | undefined {
  const child = treeNode(value).children?.find((c) => c.segment === key)
  return child?.value
}

/** Expanded nodes and table toggles, by path, shared by every item of the table. */
export interface TreeExpansion {
  /** For nodes the user hasn't toggled: the first level, everything, or nothing open. */
  base: "first" | "all" | "none"
  open: Readonly<Record<string, boolean>>
  /** Lists of maps shown as a table. */
  tables: Readonly<Record<string, boolean>>
  /**
   * With `base: "all"`, the deepest paths (by length) open by default, set while showing an
   * item too large to open whole (see `expandAllDepth`); never stored.
   */
  depth?: number
}

export const DEFAULT_TREE_EXPANSION: TreeExpansion = { base: "first", open: {}, tables: {} }

/**
 * Whether the node at `path` is open. By default the attributes' own members show (maps and
 * lists open one level) while JSON in strings stays closed until asked for.
 */
export function isExpanded(
  expansion: TreeExpansion,
  path: readonly PathSegment[],
  holdsJson: boolean,
): boolean {
  const own = expansion.open[pathKey(path)]
  if (own !== undefined) return own
  if (expansion.base === "first") return path.length === 1 && !holdsJson
  if (expansion.base === "none") return false
  return expansion.depth === undefined || path.length <= expansion.depth
}

/**
 * Opens the node at `path` if it shows closed in `shown` (the expansion as the tree shows it,
 * which may bound `base: "all"` by depth), else closes it.
 */
export function toggleExpanded(
  expansion: TreeExpansion,
  path: readonly PathSegment[],
  holdsJson: boolean,
  shown: TreeExpansion = expansion,
): TreeExpansion {
  const open = !isExpanded(shown, path, holdsJson)
  return { ...expansion, open: { ...expansion.open, [pathKey(path)]: open } }
}

/**
 * Deepest path (attribute name included) the tree shows a row for. DynamoDB stops maps and
 * lists there, but JSON in a string can nest thousands of levels; a container at this depth
 * shows as a summary instead of its members (see `rowNode`).
 */
export const MAX_TREE_DEPTH = MAX_DOCUMENT_DEPTH

/** Most rows Expand all opens at once; a larger item opens only as many levels as fit. */
export const EXPAND_LIMIT = 2000

/**
 * The depth bound for a tree whose expansion has `base` (see `expandAllDepth`): null unless it
 * opens everything. It holds in a search filter too, which shows the whole subtree of a
 * matching map or list; `boundExpansion` keeps the rows above the matches open past it.
 */
export function shownExpandDepth(
  base: TreeExpansion["base"],
  item: Item,
  names: readonly string[],
  limit = EXPAND_LIMIT,
): number | null {
  return base === "all" ? expandAllDepth(item, names, limit) : null
}

/**
 * `shown` bounded to `depth` (null leaves it as it is), with the rows in `keep` open past the
 * bound unless `shown` itself says otherwise (a row toggled closed stays closed). In filter mode
 * `keep` is the rows above the matches, so a leaf deep in a large list (`l[2998].x.y`) still
 * shows while a matching container's own subtree stays bounded.
 */
export function boundExpansion(
  shown: TreeExpansion,
  depth: number | null,
  keep: ReadonlySet<string>,
): TreeExpansion {
  if (depth === null) return shown
  const open: Record<string, boolean> = {}
  for (const key of keep) open[key] = true
  return { ...shown, open: { ...open, ...shown.open }, depth }
}

/**
 * How deep Expand all opens `item` (attributes in `names`): null when every row fits in
 * `limit` rows, else the deepest path length whose containers can all open within it (at
 * least 1, the attributes' own members, as the tree shows by default). The tree isn't
 * virtualised, so an item with tens of thousands of nested values would otherwise render them
 * all at once. Counting stops at the first level past the limit.
 */
export function expandAllDepth(
  item: Item,
  names: readonly string[],
  limit = EXPAND_LIMIT,
): number | null {
  let level: TreeValue[] = names.flatMap((name) => (item[name] ? [wire(item[name])] : []))
  let rows = level.length
  // `level` holds the rows whose paths are `depth + 1` long; none go past MAX_TREE_DEPTH.
  for (let depth = 0; level.length > 0 && depth + 1 < MAX_TREE_DEPTH; depth += 1) {
    const next: TreeValue[] = []
    for (const value of level) {
      for (const child of treeNode(value).children ?? []) next.push(child.value)
      if (rows + next.length > limit) return Math.max(depth, 1)
    }
    rows += next.length
    level = next
  }
  return null
}

/** Opens or closes every node; table toggles stay. */
export function setAllExpanded(expansion: TreeExpansion, open: boolean): TreeExpansion {
  return { ...expansion, base: open ? "all" : "none", open: {} }
}

export function isTable(expansion: TreeExpansion, path: readonly PathSegment[]): boolean {
  return expansion.tables[pathKey(path)] === true
}

export function toggleTable(expansion: TreeExpansion, path: readonly PathSegment[]): TreeExpansion {
  const key = pathKey(path)
  return { ...expansion, tables: { ...expansion.tables, [key]: !expansion.tables[key] } }
}

/**
 * Leaves the table of the list at `path` for the tree, with the way down to `target` (a path
 * below it) open, so a nested table cell can be followed.
 */
export function revealInTree(
  expansion: TreeExpansion,
  path: readonly PathSegment[],
  target: readonly PathSegment[],
): TreeExpansion {
  const open = { ...expansion.open }
  for (let depth = path.length; depth <= target.length; depth += 1) {
    open[pathKey(target.slice(0, depth))] = true
  }
  return { ...expansion, open, tables: { ...expansion.tables, [pathKey(path)]: false } }
}
