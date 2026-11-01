import { MAX_DISPLAY_CHARS } from "./cellFormat"
import type { PathSegment } from "./dynamo"
import {
  inlineEditType,
  jsonLeafType,
  type PendingAttribute,
  type PendingItemEdit,
} from "./dynamoEdits"
import {
  attributeTag,
  jsonInString,
  jsonStringReadOnlyReason,
  type JsonInString,
} from "./dynamoJson"
import { jsonAt, pathKey } from "./dynamoPath"
import { MAX_TREE_DEPTH, treeNode, type TreeNode, type TreeValue } from "./dynamoTree"
import type { KeyRole } from "./dynamoView"
import {
  isImeComposing,
  isMac,
  matchesShortcut,
  parseShortcut,
  type ImeKeyLike,
  type KeyLike,
} from "./shortcuts"

/**
 * How the item panel's tree shows and edits its rows: where a row sits (attribute, map, list,
 * set or JSON in a string), whether it can be edited in place, whether a pending change marks
 * it, and which keys open, commit and close a value's field.
 */

/** Where a JSON value inside a string sits: the string's path and whether it can be edited. */
export interface JsonHost {
  path: readonly PathSegment[]
  /** Why the JSON is read-only, or null when its values can be edited. */
  readOnly: string | null
  /** Numbers as written in the string, where that differs from the parsed number's text. */
  numbers: ReadonlyMap<string, string>
}

/** Where a row sits in the item. */
export interface Place {
  path: readonly PathSegment[]
  /** Set inside JSON stored in a string. */
  host: JsonHost | null
  /** Members of SS, NS and BS have no document path, so they can't be edited. */
  inSet: boolean
  /** Key role of the top-level attribute; nothing under a key is edited in place. */
  keyRole: KeyRole
}

/** The item's pending edits as every row of one tree sees them. */
export interface TreeEditView {
  edit: PendingItemEdit | undefined
  /** Changes the item as loaded now no longer matches; shown, but not laid over the item. */
  conflicts: ReadonlySet<PendingAttribute>
  /** False while changes are applied, the key schema is unknown or the item has no key. */
  editable: boolean
  /** From `loadedJson(edit)`, built once per edit rather than once per JSON leaf. */
  loaded: ReadonlyMap<string, JsonInString | null>
}

/**
 * The JSON each pending change's string held as loaded (null when it held none), by `pathKey`
 * of the string. Changes whose value wasn't a string have no entry.
 */
export function loadedJson(
  edit: PendingItemEdit | undefined,
): ReadonlyMap<string, JsonInString | null> {
  const loaded = new Map<string, JsonInString | null>()
  for (const [key, change] of Object.entries(edit?.changes ?? {})) {
    const before = change.before
    if (before && attributeTag(before) === "S") loaded.set(key, jsonInString(String(before.S)))
  }
  return loaded
}

/** The JSON its members sit in: the string at `place` when it holds JSON, else its own. */
export function membersHost(place: Place, node: TreeNode): JsonHost | null {
  return node.json
    ? {
        path: place.path,
        readOnly: jsonStringReadOnlyReason(node.json),
        numbers: node.json.numbers,
      }
    : place.host
}

/**
 * A JSON number as its string has it, when that differs from how JavaScript prints it:
 * `1000000000000000000000` rather than `1e+21`, `1.50` rather than `1.5`. Such JSON is
 * read-only (it isn't compact), so the stored text is what the tree shows, searches and copies.
 */
export function numberSource(place: Place, value: TreeValue): string | undefined {
  const host = place.host
  if (!host || value.kind !== "json" || typeof value.value !== "number") return undefined
  return host.numbers.get(pathKey(place.path.slice(host.path.length)))
}

/**
 * The node a row shows: `treeNode`, with a JSON number's stored text (see `numberSource`), and
 * a map, list or JSON container at MAX_TREE_DEPTH as a summary with no members.
 */
export function rowNode(place: Place, value: TreeValue): TreeNode {
  const node = treeNode(value)
  if (node.children && place.path.length >= MAX_TREE_DEPTH) {
    return { ...node, children: null, text: `${node.text}, nested too deep to show` }
  }
  const source = numberSource(place, value)
  return source === undefined ? node : { ...node, text: source }
}

/** Where the member `segment` of the row at `place` (holding `value`, shown as `node`) sits. */
export function memberPlace(
  place: Place,
  value: TreeValue,
  node: TreeNode,
  segment: PathSegment,
): Place {
  const tag = value.kind === "wire" ? attributeTag(value.value) : null
  return {
    path: [...place.path, segment],
    host: membersHost(place, node),
    inSet: place.inSet || tag === "SS" || tag === "NS" || tag === "BS",
    keyRole: place.keyRole,
  }
}

/** Text a leaf's field starts with: the value as stored, not as displayed. */
export function editText(value: TreeValue): string {
  if (value.kind === "json") return String(value.value)
  const tag = attributeTag(value.value)
  return tag ? String(value.value[tag]) : ""
}

/** Characters of a leaf's shown text that are its value, before the `…` of a long one. */
export function shownLength(value: TreeValue, node: TreeNode): number {
  return editText(value).length > MAX_DISPLAY_CHARS ? node.text.length - 1 : node.text.length
}

/** Whether the leaf at `place` can be edited in place. */
export function canEdit(view: TreeEditView, place: Place, value: TreeValue): boolean {
  if (!view.editable || place.inSet || place.keyRole !== null) return false
  if (value.kind === "json") {
    return place.host?.readOnly === null && jsonLeafType(value.value) !== null
  }
  return inlineEditType(value.value, null) !== null && treeNode(value).json === null
}

/** A leaf inside JSON differs from the string it was loaded from. */
export function jsonLeafChanged(view: TreeEditView, place: Place, value: TreeValue): boolean {
  const host = place.host
  const key = host && pathKey(host.path)
  if (!host || !key || !view.loaded.has(key)) return false
  const loaded = view.loaded.get(key)
  return !loaded || jsonAt(loaded.value, place.path.slice(host.path.length)) !== value.value
}

/** A pending change marks the leaf at `place`. */
export function isChanged(view: TreeEditView, place: Place, value: TreeValue): boolean {
  if (place.host) return jsonLeafChanged(view, place, value)
  return Boolean(view.edit?.changes[pathKey(place.path)])
}

/** A conflicting change sits at `place` (or, for a JSON value, at the string holding it). */
export function isConflict(view: TreeEditView, place: Place): boolean {
  const change = view.edit?.changes[pathKey(place.host?.path ?? place.path)]
  return change !== undefined && view.conflicts.has(change)
}

/** Keys of a value's field in the tree, matched on the physical key with no modifier held. */
export const TREE_EDIT_SHORTCUTS = {
  /** On a focused value: opens its field. */
  edit: parseShortcut("Enter"),
  /** Also opens a focused value's field, as F2 renames in a file manager. */
  editAlt: parseShortcut("F2"),
  /** In the open field: stages the value and closes the field. */
  commit: parseShortcut("Enter"),
  /** In the open field: closes it without staging. */
  cancel: parseShortcut("Escape"),
} as const

/** A keydown, native or React's `nativeEvent`, with its IME composition state. */
export type TreeKeyEvent = KeyLike & ImeKeyLike

/**
 * Whether a key on a focused value opens its field: bare Enter or F2 only. Mod+Enter and
 * Shift+Enter belong to the app (Run), and a key that ends an IME composition to the IME.
 */
export function startsTreeEdit(event: TreeKeyEvent, mac = isMac()): boolean {
  if (isImeComposing(event)) return false
  return (
    matchesShortcut(event, TREE_EDIT_SHORTCUTS.edit, mac) ||
    matchesShortcut(event, TREE_EDIT_SHORTCUTS.editAlt, mac)
  )
}

/**
 * What a key does in a value's open field. `composing` while an IME composition is open: Enter
 * then confirms a Hangul syllable or kana, and Esc drops the composition, so neither may commit
 * or close the field mid-word. Enter with Mod or Ctrl held is left to the app's shortcuts.
 */
export function treeFieldKey(
  event: TreeKeyEvent,
  mac = isMac(),
): "composing" | "commit" | "cancel" | null {
  if (isImeComposing(event)) return "composing"
  if (matchesShortcut(event, TREE_EDIT_SHORTCUTS.commit, mac)) return "commit"
  if (matchesShortcut(event, TREE_EDIT_SHORTCUTS.cancel, mac)) return "cancel"
  return null
}
