import { z } from "zod"
import type { ConnectionConfig, ConnectionId } from "./connections"
import { ipc } from "./ipc"

export type FolderId = string

export interface LayoutFolder {
  id: FolderId
  name: string
  collapsed: boolean
}

/** A sidebar entry: a connection, or a folder holding connections and other folders. */
export type LayoutItem =
  | { type: "connection"; id: ConnectionId }
  | { type: "folder"; id: FolderId; children: readonly LayoutItem[] }

/**
 * Sidebar order and folders of the connections, saved as `connection-layout.json`. Folder names
 * and collapse state live in `folders`; where each folder sits lives in the `items` tree.
 * Version 1 had folders one level deep, with connection ids as their children.
 */
export interface ConnectionLayout {
  version: 2
  folders: readonly LayoutFolder[]
  items: readonly LayoutItem[]
}

/** A connection or a folder, as the target or subject of a move. */
export type LayoutRef = { type: "connection"; id: ConnectionId } | { type: "folder"; id: FolderId }

/** Where a move lands relative to its target; `inside` is only valid for a folder target. */
export type DropPosition = "before" | "after" | "inside"

export const EMPTY_LAYOUT: ConnectionLayout = { version: 2, folders: [], items: [] }

export const DEFAULT_FOLDER_NAME = "New folder"

/** Longest folder name kept; longer names are cut. */
export const FOLDER_NAME_MAX = 100

/** Deepest folder nesting: a top-level folder is 1 deep, a folder in it 2, and so on. */
export const MAX_FOLDER_DEPTH = 32

const folderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  collapsed: z.boolean().catch(false),
})

const connectionItemSchema = z.object({ type: z.literal("connection"), id: z.string().min(1) })

const folderItemSchema = z.object({
  type: z.literal("folder"),
  id: z.string().min(1),
  children: z.array(z.unknown()),
})

const parseEach = <T>(schema: z.ZodType<T>, raw: readonly unknown[]): T[] =>
  raw.flatMap((entry) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })

/** Version 1 folder children are connection ids. */
const parseIds = (raw: readonly unknown[]): LayoutItem[] =>
  raw.flatMap((id): LayoutItem[] =>
    typeof id === "string" && id.length > 0 ? [{ type: "connection", id }] : [],
  )

/** Every connection anywhere in `raw`, in order, without the folders around them. */
function parseFlat(raw: readonly unknown[]): LayoutItem[] {
  const items: LayoutItem[] = []
  // A stack instead of recursion, as the input may be nested arbitrarily deep.
  const pending = [...raw].reverse()
  while (pending.length > 0) {
    const entry = pending.pop()
    const connection = connectionItemSchema.safeParse(entry)
    const folder = folderItemSchema.safeParse(entry)
    if (connection.success) items.push(connection.data)
    else if (folder.success) pending.push(...[...folder.data.children].reverse())
  }
  return items
}

/** Items of a version `version` file whose folders sit `depth` folders deep. */
function parseItems(raw: readonly unknown[], version: 1 | 2, depth: number): LayoutItem[] {
  return raw.flatMap((entry): LayoutItem[] => {
    const connection = connectionItemSchema.safeParse(entry)
    if (connection.success) return [connection.data]
    const folder = folderItemSchema.safeParse(entry)
    if (!folder.success) return []
    const { id, children } = folder.data
    const parsed =
      version === 1
        ? parseIds(children)
        : depth < MAX_FOLDER_DEPTH
          ? parseItems(children, 2, depth + 1)
          : parseFlat(children)
    return [{ type: "folder", id, children: parsed }]
  })
}

/**
 * Reads the IPC response, which is not trusted: anything but a version 1 or 2 layout is null,
 * and folders or items that don't parse are dropped. A version 1 layout comes back as the same
 * tree in version 2. Below `MAX_FOLDER_DEPTH` levels the tree is flattened: a folder at that
 * depth holds every connection under it, and `reconcileLayout` puts the deeper folders back at
 * the top level, empty. Unknown and
 * repeated ids are left to `reconcileLayout`, which knows the connections.
 */
export function normalizeLayout(raw: unknown): ConnectionLayout | null {
  const shape = z
    .object({
      version: z.union([z.literal(1), z.literal(2)]),
      folders: z.array(z.unknown()),
      items: z.array(z.unknown()),
    })
    .safeParse(raw)
  if (!shape.success) return null
  return {
    version: 2,
    folders: parseEach(folderSchema, shape.data.folders),
    items: parseItems(shape.data.items, shape.data.version, 1),
  }
}

const byName = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

/**
 * The layout for the current connections: unknown (deleted) ids and repeats are dropped, a
 * folder item without a folder is replaced by what it holds, a folder without an item is
 * appended at the top level, empty folders stay, and
 * connections the layout doesn't place yet are appended at the top level in name order.
 */
export function reconcileLayout(
  layout: ConnectionLayout,
  connections: readonly ConnectionConfig[],
): ConnectionLayout {
  const known = new Set(connections.map((c) => c.id))
  const folders = layout.folders.filter(
    (folder, index) => layout.folders.findIndex((f) => f.id === folder.id) === index,
  )
  const folderIds = new Set(folders.map((f) => f.id))
  const placed = new Set<ConnectionId>()
  const placedFolders = new Set<FolderId>()
  const keep = (items: readonly LayoutItem[]): LayoutItem[] =>
    items.flatMap((item): LayoutItem[] => {
      if (item.type === "connection") {
        if (!known.has(item.id) || placed.has(item.id)) return []
        placed.add(item.id)
        return [item]
      }
      // What a folder without a folder (or a repeat) holds takes its place, as on delete.
      if (!folderIds.has(item.id) || placedFolders.has(item.id)) return keep(item.children)
      placedFolders.add(item.id)
      return [{ type: "folder", id: item.id, children: keep(item.children) }]
    })
  const items = keep(layout.items)
  const unplacedFolders = folders
    .filter((f) => !placedFolders.has(f.id))
    .map((f): LayoutItem => ({ type: "folder", id: f.id, children: [] }))
  const unplaced = connections
    .filter((c) => !placed.has(c.id))
    .sort(byName)
    .map((c): LayoutItem => ({ type: "connection", id: c.id }))
  return { version: 2, folders, items: [...items, ...unplacedFolders, ...unplaced] }
}

/** Where an item sits: the folders around it (outermost first) and its index among siblings. */
interface Slot {
  path: readonly FolderId[]
  index: number
}

const isRef = (item: { type: string; id: string }, ref: LayoutRef) =>
  item.type === ref.type && item.id === ref.id

const parentOf = (slot: Slot): FolderId | null => slot.path.at(-1) ?? null

const folderRef = (id: FolderId): LayoutRef => ({ type: "folder", id })

function findSlot(
  items: readonly LayoutItem[],
  ref: LayoutRef,
  path: readonly FolderId[] = [],
): Slot | null {
  for (const [index, item] of items.entries()) {
    if (isRef(item, ref)) return { path, index }
    if (item.type === "folder") {
      const slot = findSlot(item.children, ref, [...path, item.id])
      if (slot) return slot
    }
  }
  return null
}

/** The children of folder `parent`, or the top-level items for `null`; null when not placed. */
function childrenOf(
  items: readonly LayoutItem[],
  parent: FolderId | null,
): readonly LayoutItem[] | null {
  if (parent === null) return items
  const slot = findSlot(items, { type: "folder", id: parent })
  const folder = slot && itemAt(items, slot)
  return folder?.type === "folder" ? folder.children : null
}

const itemAt = (items: readonly LayoutItem[], slot: Slot): LayoutItem | null =>
  childrenOf(items, parentOf(slot))?.[slot.index] ?? null

/** How many folders a child of `parent` sits in: 0 at the top level; null when not placed. */
function nesting(items: readonly LayoutItem[], parent: FolderId | null): number | null {
  if (parent === null) return 0
  const slot = findSlot(items, folderRef(parent))
  return slot && slot.path.length + 1
}

/** Folder levels in `item`: 0 for a connection, 1 for a folder without subfolders. */
const height = (item: LayoutItem): number =>
  item.type === "folder" ? 1 + Math.max(0, ...item.children.map(height)) : 0

/** `items` with the children of folder `parent` (the top level for `null`) run through `change`. */
function updateChildren(
  items: readonly LayoutItem[],
  parent: FolderId | null,
  change: (children: readonly LayoutItem[]) => LayoutItem[],
): LayoutItem[] {
  if (parent === null) return change(items)
  return items.map((item) => {
    if (item.type !== "folder") return item
    if (item.id === parent) return { ...item, children: change(item.children) }
    return { ...item, children: updateChildren(item.children, parent, change) }
  })
}

const insertAt = <T>(list: readonly T[], index: number, value: T): T[] => [
  ...list.slice(0, index),
  value,
  ...list.slice(index),
]

/** `items` with `item` at `index` among the children of `parent` (the top level for `null`). */
const insertItem = (
  items: readonly LayoutItem[],
  parent: FolderId | null,
  index: number,
  item: LayoutItem,
) => updateChildren(items, parent, (children) => insertAt(children, index, item))

/** `items` without the item at `slot`. */
const removeItem = (items: readonly LayoutItem[], slot: Slot) =>
  updateChildren(items, parentOf(slot), (children) =>
    children.filter((_, index) => index !== slot.index),
  )

/** Where an item dropped `position` of `target` lands in `items`: its parent and index there. */
function dropSlot(
  items: readonly LayoutItem[],
  target: LayoutRef,
  position: DropPosition,
): { parent: FolderId | null; index: number } | null {
  if (position === "inside") {
    const children = childrenOf(items, target.id)
    return children && { parent: target.id, index: children.length }
  }
  const slot = findSlot(items, target)
  return slot && { parent: parentOf(slot), index: slot.index + (position === "after" ? 1 : 0) }
}

/**
 * Moves `ref` before, after or into `target`, at any depth. Before or after an item it joins
 * that item's folder (or the top level); inside a folder it becomes the folder's last child.
 * Anything else (a folder into itself or one of its subfolders, a connection as an `inside`
 * target, a missing id, folders nested deeper than `MAX_FOLDER_DEPTH`) leaves the layout as it
 * is.
 */
export function moveItem(
  layout: ConnectionLayout,
  ref: LayoutRef,
  target: LayoutRef,
  position: DropPosition,
): ConnectionLayout {
  if (isRef(target, ref) || (position === "inside" && target.type !== "folder")) return layout
  const from = findSlot(layout.items, ref)
  const moving = from && itemAt(layout.items, from)
  if (!from || !moving) return layout
  if (moving.type === "folder" && findSlot(moving.children, target)) return layout
  const items = removeItem(layout.items, from)
  const to = dropSlot(items, target, position)
  const around = to && nesting(items, to.parent)
  if (!to || around === null || around + height(moving) > MAX_FOLDER_DEPTH) return layout
  return { ...layout, items: insertItem(items, to.parent, to.index, moving) }
}

/**
 * Whether dropping `ref` `position` of `target` changes anything (used to show the drop
 * indicator only where a drop would do something).
 */
export function canDrop(
  layout: ConnectionLayout,
  ref: LayoutRef,
  target: LayoutRef,
  position: DropPosition,
): boolean {
  const next = moveItem(layout, ref, target, position)
  return next !== layout && JSON.stringify(next.items) !== JSON.stringify(layout.items)
}

/**
 * Moves `ref` one step up (`-1`) or down (`1`) among its siblings. An item at the edge of its
 * folder steps out of it, before or after the folder. Top-level items at the edge stay.
 * Returns the same layout when nothing moves.
 */
export function moveStep(layout: ConnectionLayout, ref: LayoutRef, step: -1 | 1): ConnectionLayout {
  const slot = findSlot(layout.items, ref)
  if (!slot) return layout
  const position = step < 0 ? "before" : "after"
  const sibling = childrenOf(layout.items, parentOf(slot))?.[slot.index + step]
  if (sibling) return moveItem(layout, ref, sibling, position)
  const parent = parentOf(slot)
  return parent === null ? layout : moveItem(layout, ref, folderRef(parent), position)
}

/**
 * Puts `ref` at the end of folder `folderId`, or with `null` back at the top level right after
 * the top-level folder it was in. Returns the same layout when nothing moves, or when `ref` is a
 * folder and `folderId` the folder itself or one of its subfolders.
 */
export function moveToFolder(
  layout: ConnectionLayout,
  ref: LayoutRef,
  folderId: FolderId | null,
): ConnectionLayout {
  const slot = findSlot(layout.items, ref)
  if (!slot || parentOf(slot) === folderId) return layout
  if (folderId !== null) return moveItem(layout, ref, folderRef(folderId), "inside")
  return moveItem(layout, ref, folderRef(slot.path[0]), "after")
}

/** Places connection `id` right after `sourceId`, in the same folder (for a duplicate). */
export function placeAfter(
  layout: ConnectionLayout,
  id: ConnectionId,
  sourceId: ConnectionId,
): ConnectionLayout {
  if (id === sourceId) return layout
  const item: LayoutItem = { type: "connection", id }
  const own = findSlot(layout.items, item)
  const items = own ? removeItem(layout.items, own) : layout.items
  const source = findSlot(items, { type: "connection", id: sourceId })
  return {
    ...layout,
    items: source ? insertItem(items, parentOf(source), source.index + 1, item) : [...items, item],
  }
}

/** `DEFAULT_FOLDER_NAME`, numbered ("New folder 2", …) when a folder already uses it. */
export function newFolderName(layout: ConnectionLayout): string {
  const taken = new Set(layout.folders.map((f) => f.name.toLowerCase()))
  if (!taken.has(DEFAULT_FOLDER_NAME.toLowerCase())) return DEFAULT_FOLDER_NAME
  let n = 2
  while (taken.has(`${DEFAULT_FOLDER_NAME} ${n}`.toLowerCase())) n += 1
  return `${DEFAULT_FOLDER_NAME} ${n}`
}

/** Trimmed and cut to `FOLDER_NAME_MAX`; null when nothing is left. */
export function cleanFolderName(name: string): string | null {
  const trimmed = name.trim().slice(0, FOLDER_NAME_MAX).trim()
  return trimmed || null
}

/**
 * Adds an empty, expanded folder at the end of folder `parent`, or of the top level for `null`.
 * The parent is expanded so the new folder shows. Nothing changes where the new folder would
 * sit deeper than `MAX_FOLDER_DEPTH`.
 */
export function createFolder(
  layout: ConnectionLayout,
  id: FolderId,
  name: string,
  parent: FolderId | null = null,
): ConnectionLayout {
  const clean = cleanFolderName(name) ?? newFolderName(layout)
  if (layout.folders.some((f) => f.id === id)) return layout
  const children = childrenOf(layout.items, parent)
  const around = nesting(layout.items, parent)
  if (!children || around === null || around + 1 > MAX_FOLDER_DEPTH) return layout
  const folders = layout.folders.map((f) => (f.id === parent ? { ...f, collapsed: false } : f))
  return {
    ...layout,
    folders: [...folders, { id, name: clean, collapsed: false }],
    items: insertItem(layout.items, parent, children.length, { type: "folder", id, children: [] }),
  }
}

function updateFolder(
  layout: ConnectionLayout,
  id: FolderId,
  patch: Partial<Omit<LayoutFolder, "id">>,
): ConnectionLayout {
  if (!layout.folders.some((f) => f.id === id)) return layout
  return { ...layout, folders: layout.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) }
}

/** Renames a folder; a blank name keeps the old one. */
export function renameFolder(
  layout: ConnectionLayout,
  id: FolderId,
  name: string,
): ConnectionLayout {
  const clean = cleanFolderName(name)
  return clean === null ? layout : updateFolder(layout, id, { name: clean })
}

export function setFolderCollapsed(
  layout: ConnectionLayout,
  id: FolderId,
  collapsed: boolean,
): ConnectionLayout {
  return updateFolder(layout, id, { collapsed })
}

/** Removes a folder; what it holds, subfolders included, takes its place in its parent, in order. */
export function deleteFolder(layout: ConnectionLayout, id: FolderId): ConnectionLayout {
  if (!layout.folders.some((f) => f.id === id)) return layout
  const unwrap = (items: readonly LayoutItem[]): LayoutItem[] =>
    items.flatMap((item): LayoutItem[] => {
      if (item.type !== "folder") return [item]
      return item.id === id ? unwrap(item.children) : [{ ...item, children: unwrap(item.children) }]
    })
  return {
    ...layout,
    folders: layout.folders.filter((f) => f.id !== id),
    items: unwrap(layout.items),
  }
}

/** A placed folder and the names of the folders from the top level down to it, its own last. */
export interface FolderPath {
  folder: LayoutFolder
  names: readonly string[]
}

/** Every placed folder of a reconciled layout in tree order, with its path. */
export function folderPaths(layout: ConnectionLayout): FolderPath[] {
  const folders = new Map(layout.folders.map((f) => [f.id, f]))
  const walk = (items: readonly LayoutItem[], names: readonly string[]): FolderPath[] =>
    items.flatMap((item) => {
      const folder = item.type === "folder" ? folders.get(item.id) : undefined
      if (item.type !== "folder" || !folder) return []
      const path = [...names, folder.name]
      return [{ folder, names: path }, ...walk(item.children, path)]
    })
  return walk(layout.items, [])
}

/** Where `moveToFolder` could send `ref`: `null` for the top level, then every placed folder. */
export interface MoveTarget {
  folderId: FolderId | null
  /** Whether moving `ref` there would do nothing: it is already there, the target is `ref`
   *  itself or one of its subfolders (moving a folder), or the result would nest deeper than
   *  `MAX_FOLDER_DEPTH`. */
  disabled: boolean
}

/** Every target `moveToFolder(layout, ref, …)` accepts, with whether it would change anything. */
export function moveTargets(layout: ConnectionLayout, ref: LayoutRef): MoveTarget[] {
  const disabledFor = (folderId: FolderId | null): boolean =>
    moveToFolder(layout, ref, folderId) === layout
  const topLevel: MoveTarget = { folderId: null, disabled: disabledFor(null) }
  const folders = folderPaths(layout).map(({ folder }): MoveTarget => ({
    folderId: folder.id,
    disabled: disabledFor(folder.id),
  }))
  return [topLevel, ...folders]
}

/** A sidebar row: a connection, or a folder with the rows inside it. */
export type LayoutEntry =
  | { type: "connection"; config: ConnectionConfig }
  | {
      type: "folder"
      folder: LayoutFolder
      children: readonly LayoutEntry[]
      /** Connections in the folder and its subfolders. */
      count: number
    }

/**
 * What the sidebar shows for a reconciled layout. With `matches`, only matching connections are
 * kept, with the folders around them, and folders without any are hidden; without it every
 * folder shows, empty ones too.
 */
export function layoutEntries(
  layout: ConnectionLayout,
  connections: readonly ConnectionConfig[],
  matches?: (config: ConnectionConfig) => boolean,
): LayoutEntry[] {
  const byId = new Map(connections.map((c) => [c.id, c]))
  const folders = new Map(layout.folders.map((f) => [f.id, f]))
  const entries = (items: readonly LayoutItem[]): LayoutEntry[] =>
    items.flatMap((item): LayoutEntry[] => {
      if (item.type === "connection") {
        const config = byId.get(item.id)
        return config && (!matches || matches(config)) ? [{ type: "connection", config }] : []
      }
      const folder = folders.get(item.id)
      if (!folder) return []
      const children = entries(item.children)
      const count = children.reduce(
        (sum, child) => sum + (child.type === "folder" ? child.count : 1),
        0,
      )
      if (matches && count === 0) return []
      return [{ type: "folder", folder, children, count }]
    })
  return entries(layout.items)
}

export const connectionLayoutApi = {
  /** Null when nothing was saved or the file was unusable. */
  load: async () => normalizeLayout(await ipc<unknown>("connection_layout_load")),
  save: (layout: ConnectionLayout) => ipc<void>("connection_layout_save", { layout }),
}
