import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import type { Item, PathSegment } from "../../lib/dynamo"
import type { PendingItemEdit } from "../../lib/dynamoEdits"
import { pathKey, releasedPath } from "../../lib/dynamoPath"
import {
  ancestorKeys,
  EMPTY_OVERLAY,
  findFilter,
  findIndex,
  findInItem,
  hitPositions,
  orderHits,
  overlayReveal,
  overlaySetAll,
  overlayToggle,
  overlayToggleTable,
  rescope,
  REVEAL_LIMIT,
  revealKeys,
  searchExpansion,
  stepMatch,
  type FindBarState,
  type FindEntry,
  type FindFilter,
  type FindHit,
  type Scoped,
  type SearchOverlay,
} from "../../lib/dynamoSearch"
import type { FindChoices } from "../../lib/dynamoTabs"
import { expandAllDepth, type TreeExpansion } from "../../lib/dynamoTree"
import { expandTree, revealTreePath, toggleTreeNode, toggleTreeTable } from "./actions"
import { CLOSED_FIND, findBarKey, useItemFind } from "./findStore"

/** A search showing in the tree. */
export interface TreeFind {
  via: "text" | "path"
  hits: readonly FindHit[]
  /** Position of each hit by row key. */
  positions: ReadonlyMap<string, number>
  /** Row key of the current hit. */
  current: string | null
  /** Rows above hits; a table cell that holds one is marked. */
  above: ReadonlySet<string>
  /** Set in filter mode: the rows that show. */
  filter: FindFilter | null
}

/** Where the cursor is among the hits of one search (query and toggles). */
interface FindCursor {
  at: number
  key: string | null
}

const START: FindCursor = { at: 0, key: null }

const NO_ENTRIES: readonly FindEntry[] = []

/** Scrolls to the row at `path`, or to the nearest row above it that shows. */
export function revealRow(container: HTMLElement | null, path: readonly PathSegment[]) {
  requestAnimationFrame(() => {
    for (let depth = path.length; depth > 0; depth -= 1) {
      const key = pathKey(path.slice(0, depth))
      const row = container?.querySelector(`[data-path="${CSS.escape(key)}"]`)
      if (row) {
        row.scrollIntoView({ block: "nearest" })
        return
      }
    }
  })
}

interface TreeFindInput {
  tabId: string
  /** The table the item is from; each table has its own find bar. */
  table: string | null
  /** The item with its pending values applied. */
  item: Item
  /** The tree's attributes, in the order it shows them. */
  names: readonly string[]
  edit: PendingItemEdit | undefined
  /** The tab's own expansion, which a search lays its reveals and toggles over. */
  expansion: TreeExpansion
  findChoices: FindChoices
}

export interface TreeFindState {
  barKey: string
  bar: FindBarState
  searching: boolean
  /** The search as the tree shows it, or null without a query. */
  find: TreeFind | null
  /** The expansion the tree shows: the tab's own, or during a search the search's. */
  expansion: TreeExpansion
  /** Set when Expand all opened only this many levels of an item too large to open whole. */
  expandDepth: number | null
  count: number
  /** Position of the current hit. */
  at: number
  via: "text" | "path"
  asText: number
  /** Too many matches to open all their rows; only the current one's open. */
  capped: boolean
  /** The tree's scroll container, for scrolling to the current hit. */
  treeRef: RefObject<HTMLDivElement | null>
  step: (direction: 1 | -1) => void
  /** Expansion changes; during a search they last only as long as the search. */
  toggle: (path: readonly PathSegment[], holdsJson: boolean) => void
  toggleTable: (path: readonly PathSegment[]) => void
  /** Leaves the table of the list at `path` for the tree, opened down to `target`. */
  reveal: (path: readonly PathSegment[], target: readonly PathSegment[]) => void
  setAll: (open: boolean) => void
  /** Marks the leaf at `path` as the one whose field is open, kept in view by filter mode. */
  setEditing: (path: readonly PathSegment[]) => void
  /** Lets go of the open-field mark if the leaf at `path` still holds it. */
  releaseEditing: (path: readonly PathSegment[]) => void
}

/**
 * The tree's find bar as it drives the tree: matching the query against the item, the cursor
 * over the hits, the rows the search opens or filters to, and the toggles made during a search,
 * which last only as long as it.
 */
export function useTreeFind(input: TreeFindInput): TreeFindState {
  const { tabId, table, item, names, edit, expansion } = input
  const { mode, caseSensitive, keys, values } = input.findChoices
  const treeRef = useRef<HTMLDivElement>(null)

  const barKey = findBarKey(tabId, table)
  const bar = useItemFind((s) => s.bars[barKey] ?? CLOSED_FIND)
  // Typing stays responsive on large items: matching and the tree follow a step behind.
  const query = useDeferredValue(bar.open ? bar.query : "")
  const search = JSON.stringify([query, caseSensitive, keys, values])
  // The item is indexed only while the bar is open, once per shown item.
  const entries = useMemo(
    () => (bar.open ? findIndex(item, names) : NO_ENTRIES),
    [bar.open, item, names],
  )
  const found = useMemo(
    () => findInItem(entries, query, { caseSensitive, keys, values }),
    [entries, query, caseSensitive, keys, values],
  )
  const searching = query.trim() !== ""

  // Changes to the tree during a search: kept for that search only, never saved, and dropped
  // as soon as the search changes, so typing the same query again starts afresh.
  const [overlaid, setOverlaid] = useState<Scoped<SearchOverlay>>({ search, value: EMPTY_OVERLAY })
  const scopedOverlay = rescope(overlaid, search, EMPTY_OVERLAY)
  if (scopedOverlay !== overlaid) setOverlaid(scopedOverlay)
  const overlay = scopedOverlay.value
  // Updates build on the latest overlay, so two in one click (table, then open) both stay.
  const updateOverlay = (update: (overlay: SearchOverlay) => SearchOverlay) =>
    setOverlaid((prev) => {
      const scoped = rescope(prev, search, EMPTY_OVERLAY)
      return { search, value: update(scoped.value) }
    })

  // Lists shown as tables order their cells' hits by column, as they read.
  const tables = useMemo(
    () => (searching ? { ...expansion.tables, ...overlay.tables } : expansion.tables),
    [searching, expansion.tables, overlay.tables],
  )
  const hits = useMemo(
    () => orderHits(found.hits, item, (path) => tables[pathKey(path)] === true),
    [found, item, tables],
  )
  const positions = useMemo(() => hitPositions({ ...found, hits }), [found, hits])
  const count = hits.length

  // The cursor stays on its hit while edits change the results, and restarts with a new search.
  const [stored, setCursor] = useState<Scoped<FindCursor>>({ search, value: START })
  const scopedCursor = rescope(stored, search, START)
  if (scopedCursor !== stored) setCursor(scopedCursor)
  const cursor = scopedCursor.value
  const at =
    (cursor.key !== null ? positions.get(cursor.key) : undefined) ??
    Math.min(cursor.at, Math.max(count - 1, 0))
  const currentPath = hits[at]?.path ?? null
  const current = currentPath ? pathKey(currentPath) : null

  // Pending changes and an open field stay in view in filter mode, so a value being edited
  // never vanishes from under the cursor.
  const [editing, setEditing] = useState<readonly PathSegment[] | null>(null)
  const releaseEditing = useCallback(
    (path: readonly PathSegment[]) => setEditing((current) => releasedPath(current, path)),
    [],
  )
  const pinned = useMemo(
    () => [
      ...(edit ? Object.values(edit.changes).map((change) => change.path) : []),
      ...(editing ? [editing] : []),
    ],
    [edit, editing],
  )
  const filter = useMemo(
    () =>
      searching && mode === "filter"
        ? findFilter([...hits.map((hit) => hit.path), ...pinned])
        : null,
    [searching, mode, hits, pinned],
  )
  const hitPaths = useMemo(() => hits.map((hit) => hit.path), [hits])
  // Rows above matches, which open; in highlight mode only up to REVEAL_LIMIT matches.
  const above = useMemo(
    () => (filter ? ancestorKeys([...hitPaths, ...pinned]) : ancestorKeys(hitPaths)),
    [filter, hitPaths, pinned],
  )
  const reveal = useMemo(
    () => (filter ? above : revealKeys(hitPaths, currentPath)),
    [filter, above, hitPaths, currentPath],
  )
  const focus = useMemo(
    () => (currentPath ? ancestorKeys([currentPath]) : new Set<string>()),
    [currentPath],
  )
  const asked = searching ? searchExpansion(expansion, reveal, overlay, focus) : expansion
  // Expand all on an item too large to render whole opens only as many levels as fit.
  const opensAll = asked.base === "all"
  const depth = useMemo(
    () => (opensAll ? expandAllDepth(item, names) : null),
    [opensAll, item, names],
  )
  const shownExpansion = depth === null ? asked : { ...asked, depth }

  useEffect(() => {
    if (currentPath) revealRow(treeRef.current, currentPath)
    // Scrolls when the search or the current hit changes, not on every edit.
  }, [search, current])

  return {
    barKey,
    bar,
    searching,
    find: searching ? { via: found.via, hits, positions, current, above, filter } : null,
    expansion: shownExpansion,
    expandDepth: depth,
    count,
    at,
    via: found.via,
    asText: found.asText,
    capped: !filter && count > REVEAL_LIMIT,
    treeRef,
    step: (direction) => {
      if (count === 0) return
      const next = stepMatch(at, count, direction)
      setCursor({ search, value: { at: next, key: pathKey(hits[next].path) } })
    },
    toggle: (path, holdsJson) =>
      searching
        ? updateOverlay((o) => overlayToggle(o, shownExpansion, path, holdsJson))
        : toggleTreeNode(tabId, path, holdsJson, shownExpansion),
    toggleTable: (path) =>
      searching
        ? updateOverlay((o) => overlayToggleTable(o, shownExpansion, path))
        : toggleTreeTable(tabId, path),
    reveal: (path, target) => {
      if (searching) updateOverlay((o) => overlayReveal(o, path, target))
      else revealTreePath(tabId, path, target)
      revealRow(treeRef.current, target)
    },
    setAll: (open) =>
      searching ? updateOverlay((o) => overlaySetAll(o, open)) : expandTree(tabId, open),
    setEditing,
    releaseEditing,
  }
}
