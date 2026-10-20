import { z } from "zod"
import type { ConnectionConfig, ConnectionId } from "./connections"
import { ipc } from "./ipc"

export type FolderId = string

export interface LayoutFolder {
  id: FolderId
  name: string
  collapsed: boolean
}

/** A top-level sidebar entry: a connection, or a folder holding connections (one level only). */
export type LayoutItem =
  | { type: "connection"; id: ConnectionId }
  | { type: "folder"; id: FolderId; children: readonly ConnectionId[] }

/**
 * Sidebar order and folders of the connections, saved as `connection-layout.json`. Folder names
 * and collapse state live in `folders`; where each folder sits lives in `items`.
 */
export interface ConnectionLayout {
  version: 1
  folders: readonly LayoutFolder[]
  items: readonly LayoutItem[]
}

/** A connection or a folder, as the target or subject of a move. */
export type LayoutRef = { type: "connection"; id: ConnectionId } | { type: "folder"; id: FolderId }

/** Where a move lands relative to its target; `inside` is only valid for a folder target. */
export type DropPosition = "before" | "after" | "inside"

export const EMPTY_LAYOUT: ConnectionLayout = { version: 1, folders: [], items: [] }

export const DEFAULT_FOLDER_NAME = "New folder"

/** Longest folder name kept; longer names are cut. */
export const FOLDER_NAME_MAX = 100

const folderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  collapsed: z.boolean().catch(false),
})

const itemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connection"), id: z.string().min(1) }),
  z.object({
    type: z.literal("folder"),
    id: z.string().min(1),
    children: z
      .array(z.unknown())
      .transform((ids) =>
        ids.filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
  }),
])

const parseEach = <T>(schema: z.ZodType<T>, raw: readonly unknown[]): T[] =>
  raw.flatMap((entry) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })

/**
 * Reads the IPC response, which is not trusted: anything but a version 1 layout is null, and
 * folders or items that don't parse are dropped. Unknown and repeated ids are left to
 * `reconcileLayout`, which knows the connections.
 */
export function normalizeLayout(raw: unknown): ConnectionLayout | null {
  const shape = z
    .object({ version: z.literal(1), folders: z.array(z.unknown()), items: z.array(z.unknown()) })
    .safeParse(raw)
  if (!shape.success) return null
  return {
    version: 1,
    folders: parseEach(folderSchema, shape.data.folders),
    items: parseEach(itemSchema, shape.data.items),
  }
}

const byName = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

/**
 * The layout for the current connections: unknown (deleted) ids and repeats are dropped, a
 * folder item without a folder (or a folder without an item) is fixed, empty folders stay, and
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
  const take = (id: ConnectionId) => {
    if (!known.has(id) || placed.has(id)) return false
    placed.add(id)
    return true
  }
  const items = layout.items.flatMap((item): LayoutItem[] => {
    if (item.type === "connection") return take(item.id) ? [item] : []
    if (!folderIds.has(item.id) || placedFolders.has(item.id)) return []
    placedFolders.add(item.id)
    return [{ type: "folder", id: item.id, children: item.children.filter(take) }]
  })
  const unplacedFolders = folders
    .filter((f) => !placedFolders.has(f.id))
    .map((f): LayoutItem => ({ type: "folder", id: f.id, children: [] }))
  const unplaced = connections
    .filter((c) => !placed.has(c.id))
    .sort(byName)
    .map((c): LayoutItem => ({ type: "connection", id: c.id }))
  return { version: 1, folders, items: [...items, ...unplacedFolders, ...unplaced] }
}

/** Where a connection sits: in a folder's children or at the top level (`folderId` null). */
interface Slot {
  folderId: FolderId | null
  index: number
}

function findConnection(items: readonly LayoutItem[], id: ConnectionId): Slot | null {
  for (const [index, item] of items.entries()) {
    if (item.type === "connection" && item.id === id) return { folderId: null, index }
    if (item.type === "folder") {
      const child = item.children.indexOf(id)
      if (child >= 0) return { folderId: item.id, index: child }
    }
  }
  return null
}

const findFolder = (items: readonly LayoutItem[], id: FolderId) =>
  items.findIndex((item) => item.type === "folder" && item.id === id)

/** The folder holding connection `id`, or null at the top level or when it is not placed. */
export function folderOf(layout: ConnectionLayout, id: ConnectionId): FolderId | null {
  return findConnection(layout.items, id)?.folderId ?? null
}

/** Index of the top-level item that is or contains `ref`, or -1. */
function topIndex(items: readonly LayoutItem[], ref: LayoutRef): number {
  if (ref.type === "folder") return findFolder(items, ref.id)
  const slot = findConnection(items, ref.id)
  if (!slot) return -1
  return slot.folderId === null ? slot.index : findFolder(items, slot.folderId)
}

function withoutConnection(items: readonly LayoutItem[], id: ConnectionId): LayoutItem[] {
  return items.flatMap((item): LayoutItem[] => {
    if (item.type === "connection") return item.id === id ? [] : [item]
    return item.children.includes(id)
      ? [{ ...item, children: item.children.filter((c) => c !== id) }]
      : [item]
  })
}

const insertAt = <T>(list: readonly T[], index: number, value: T): T[] => [
  ...list.slice(0, index),
  value,
  ...list.slice(index),
]

function insertConnection(
  items: readonly LayoutItem[],
  id: ConnectionId,
  slot: Slot,
): LayoutItem[] {
  if (slot.folderId === null) return insertAt(items, slot.index, { type: "connection", id })
  return items.map((item) =>
    item.type === "folder" && item.id === slot.folderId
      ? { ...item, children: insertAt(item.children, slot.index, id) }
      : item,
  )
}

/** Where a connection moved `position` of `target` lands, in `items` without it. */
function dropSlot(
  items: readonly LayoutItem[],
  target: LayoutRef,
  position: DropPosition,
): Slot | null {
  const offset = position === "after" ? 1 : 0
  if (target.type === "folder") {
    const index = findFolder(items, target.id)
    if (index < 0) return null
    const folder = items[index]
    if (position === "inside" && folder.type === "folder") {
      return { folderId: folder.id, index: folder.children.length }
    }
    return { folderId: null, index: index + offset }
  }
  if (position === "inside") return null
  const slot = findConnection(items, target.id)
  return slot && { folderId: slot.folderId, index: slot.index + offset }
}

function moveConnection(
  layout: ConnectionLayout,
  id: ConnectionId,
  target: LayoutRef,
  position: DropPosition,
): ConnectionLayout {
  if (target.type === "connection" && target.id === id) return layout
  if (!findConnection(layout.items, id)) return layout
  const items = withoutConnection(layout.items, id)
  const slot = dropSlot(items, target, position)
  return slot ? { ...layout, items: insertConnection(items, id, slot) } : layout
}

/** Folders only move among the top-level items; a target inside a folder means that folder. */
function moveFolder(
  layout: ConnectionLayout,
  id: FolderId,
  target: LayoutRef,
  position: DropPosition,
): ConnectionLayout {
  const from = findFolder(layout.items, id)
  if (position === "inside" || from < 0) return layout
  const items = layout.items.filter((_, index) => index !== from)
  const index = topIndex(items, target)
  if (index < 0) return layout
  return {
    ...layout,
    items: insertAt(items, index + (position === "after" ? 1 : 0), layout.items[from]),
  }
}

/**
 * Moves `ref` before, after or into `target`. A connection dropped before or after a connection
 * joins that connection's folder (or the top level); dropped inside a folder it becomes the
 * folder's last child. A folder only moves among top-level items. Anything else (a folder into
 * a folder, a missing id) leaves the layout as it is.
 */
export function moveItem(
  layout: ConnectionLayout,
  ref: LayoutRef,
  target: LayoutRef,
  position: DropPosition,
): ConnectionLayout {
  return ref.type === "connection"
    ? moveConnection(layout, ref.id, target, position)
    : moveFolder(layout, ref.id, target, position)
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
 * Moves `ref` one step up (`-1`) or down (`1`) among its siblings. A connection at the edge of
 * its folder steps out of it, before or after the folder. Top-level items at the edge stay.
 * Returns the same layout when nothing moves.
 */
export function moveStep(layout: ConnectionLayout, ref: LayoutRef, step: -1 | 1): ConnectionLayout {
  if (ref.type === "folder") {
    const from = findFolder(layout.items, ref.id)
    const to = from + step
    if (from < 0 || to < 0 || to >= layout.items.length) return layout
    const items = layout.items.filter((_, index) => index !== from)
    return { ...layout, items: insertAt(items, to, layout.items[from]) }
  }
  const slot = findConnection(layout.items, ref.id)
  if (!slot) return layout
  const items = withoutConnection(layout.items, ref.id)
  if (slot.folderId === null) {
    const to = slot.index + step
    if (to < 0 || to > items.length) return layout
    return { ...layout, items: insertConnection(items, ref.id, { folderId: null, index: to }) }
  }
  const folderIndex = findFolder(items, slot.folderId)
  const folder = items[folderIndex]
  const siblings = folder.type === "folder" ? folder.children.length : 0
  const to = slot.index + step
  const next: Slot =
    to < 0
      ? { folderId: null, index: folderIndex }
      : to > siblings
        ? { folderId: null, index: folderIndex + 1 }
        : { folderId: slot.folderId, index: to }
  return { ...layout, items: insertConnection(items, ref.id, next) }
}

/**
 * Puts connection `id` at the end of folder `folderId`, or with `null` back at the top level
 * right after the folder it was in. Returns the same layout when nothing moves.
 */
export function moveToFolder(
  layout: ConnectionLayout,
  id: ConnectionId,
  folderId: FolderId | null,
): ConnectionLayout {
  const slot = findConnection(layout.items, id)
  if (!slot || slot.folderId === folderId) return layout
  if (folderId !== null)
    return moveConnection(layout, id, { type: "folder", id: folderId }, "inside")
  return slot.folderId === null
    ? layout
    : moveConnection(layout, id, { type: "folder", id: slot.folderId }, "after")
}

/** Places connection `id` right after `sourceId`, in the same folder (for a duplicate). */
export function placeAfter(
  layout: ConnectionLayout,
  id: ConnectionId,
  sourceId: ConnectionId,
): ConnectionLayout {
  if (id === sourceId) return layout
  const items = withoutConnection(layout.items, id)
  const source = findConnection(items, sourceId)
  const slot = source
    ? { folderId: source.folderId, index: source.index + 1 }
    : { folderId: null, index: items.length }
  return { ...layout, items: insertConnection(items, id, slot) }
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

/** Adds an empty, expanded folder at the end of the top level. */
export function createFolder(
  layout: ConnectionLayout,
  id: FolderId,
  name: string,
): ConnectionLayout {
  const clean = cleanFolderName(name) ?? newFolderName(layout)
  if (layout.folders.some((f) => f.id === id)) return layout
  return {
    ...layout,
    folders: [...layout.folders, { id, name: clean, collapsed: false }],
    items: [...layout.items, { type: "folder", id, children: [] }],
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

/** Removes a folder; its connections take its place at the top level, in order. */
export function deleteFolder(layout: ConnectionLayout, id: FolderId): ConnectionLayout {
  if (!layout.folders.some((f) => f.id === id)) return layout
  return {
    ...layout,
    folders: layout.folders.filter((f) => f.id !== id),
    items: layout.items.flatMap((item): LayoutItem[] =>
      item.type === "folder" && item.id === id
        ? item.children.map((child) => ({ type: "connection", id: child }))
        : [item],
    ),
  }
}

/** A sidebar row group: a top-level connection, or a folder with its connections. */
export type LayoutEntry =
  | { type: "connection"; config: ConnectionConfig }
  | { type: "folder"; folder: LayoutFolder; connections: readonly ConnectionConfig[] }

/**
 * What the sidebar shows for a reconciled layout. With `matches`, only matching connections are
 * kept, and folders without any are hidden; without it every folder shows, empty ones too.
 */
export function layoutEntries(
  layout: ConnectionLayout,
  connections: readonly ConnectionConfig[],
  matches?: (config: ConnectionConfig) => boolean,
): LayoutEntry[] {
  const byId = new Map(connections.map((c) => [c.id, c]))
  const folders = new Map(layout.folders.map((f) => [f.id, f]))
  const pick = (ids: readonly ConnectionId[]) =>
    ids.flatMap((id) => {
      const config = byId.get(id)
      return config && (!matches || matches(config)) ? [config] : []
    })
  return layout.items.flatMap((item): LayoutEntry[] => {
    if (item.type === "connection") {
      return pick([item.id]).map((config) => ({ type: "connection", config }))
    }
    const folder = folders.get(item.id)
    const children = pick(item.children)
    if (!folder || (matches && children.length === 0)) return []
    return [{ type: "folder", folder, connections: children }]
  })
}

export const connectionLayoutApi = {
  /** Null when nothing was saved or the file was unusable. */
  load: async () => normalizeLayout(await ipc<unknown>("connection_layout_load")),
  save: (layout: ConnectionLayout) => ipc<void>("connection_layout_save", { layout }),
}
