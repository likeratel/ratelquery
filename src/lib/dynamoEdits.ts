import type { AttributeUpdate, AttributeValue, Item, KeySchema } from "./dynamo"
import { attributesEqual, itemKey } from "./dynamoDiff"
import { attributeTag, canonicalDecimal, type Result } from "./dynamoJson"
import { attributeSummary, type KeyRole } from "./dynamoView"
import type { AppErrorKind } from "./ipc"

/**
 * Pending inline edits of DynamoDB grid cells, applied together with one UpdateItem per item.
 *
 * Only scalar attributes are edited in the grid: S, N and BOOL keep their type, and a missing
 * attribute becomes a new S. Keys, NULL, B, maps, lists and sets open the JSON item editor
 * instead. NULL has no single type to turn into when the user types something, so it stays a
 * JSON-editor edit rather than guessing one.
 *
 * Edits are keyed by the item's table key (not its row), so they survive a page refresh and
 * still describe the same item. Each change remembers the value it started from; the write is
 * conditional on the stored value still being that.
 */

export type InlineType = "S" | "N" | "BOOL"

export interface PendingAttribute {
  /** Value when the edit started; null when the item didn't have the attribute. */
  before: AttributeValue | null
  after: AttributeValue
}

export interface PendingItemEdit {
  key: Item
  changes: Readonly<Record<string, PendingAttribute>>
  /** Error kind of the last Apply that couldn't write the item; editing it again clears this. */
  failed?: AppErrorKind
}

/** Pending edits by `keyId` of the item. */
export type DynamoEdits = Readonly<Record<string, PendingItemEdit>>

export const EMPTY_DYNAMO_EDITS: DynamoEdits = {}

/** DynamoDB number limits: 38 significant digits, magnitude 1E-130 to 9.9…E+125. */
const MAX_DIGITS = 38
const MAX_MAGNITUDE = 125
const MIN_MAGNITUDE = -130

/** Stable identity of an item key, independent of attribute order. */
export function keyId(key: Item): string {
  return JSON.stringify(
    Object.keys(key)
      .sort()
      .map((name) => [name, key[name]]),
  )
}

/** Short text naming an item by its key, e.g. `pk="u1", sk=2`, for messages. */
export function keyLabel(key: Item): string {
  return Object.entries(key)
    .map(([name, value]) => `${name}=${attributeSummary(value)}`)
    .join(", ")
}

/** How a cell can be edited inline, or null when it needs the JSON item editor. */
export function inlineEditType(
  value: AttributeValue | undefined,
  keyRole: KeyRole,
): InlineType | null {
  if (keyRole !== null) return null
  if (!value) return "S"
  const tag = attributeTag(value)
  return tag === "S" || tag === "N" || tag === "BOOL" ? tag : null
}

/** Validates a DynamoDB number; returns the trimmed text the user typed. */
export function parseDynamoNumber(text: string): Result<string> {
  const trimmed = text.trim()
  const canonical = canonicalDecimal(trimmed)
  if (canonical === null) return { ok: false, error: `"${trimmed}" isn't a number` }
  if (canonical === "0") return { ok: true, value: trimmed }
  const [mantissa, exponent] = canonical.replace(/^-/, "").split("e")
  if (mantissa.length > MAX_DIGITS) {
    return { ok: false, error: `DynamoDB numbers have at most ${MAX_DIGITS} significant digits` }
  }
  const magnitude = Number(exponent) + mantissa.length - 1
  if (magnitude > MAX_MAGNITUDE || magnitude < MIN_MAGNITUDE) {
    return { ok: false, error: "The number is outside DynamoDB's range (1E-130 to 9.9E+125)" }
  }
  return { ok: true, value: trimmed }
}

/** Typed cell text to a wire attribute of `type`. Strings are kept exactly, empty included. */
export function parseInlineValue(type: InlineType, text: string): Result<AttributeValue> {
  if (type === "S") return { ok: true, value: { S: text } }
  if (type === "N") {
    const number = parseDynamoNumber(text)
    return number.ok ? { ok: true, value: { N: number.value } } : number
  }
  const lower = text.trim().toLowerCase()
  if (lower === "true" || lower === "false") return { ok: true, value: { BOOL: lower === "true" } }
  return { ok: false, error: "Type true or false" }
}

export function pendingEditCount(edits: DynamoEdits): number {
  return Object.values(edits).reduce((sum, edit) => sum + Object.keys(edit.changes).length, 0)
}

/** The pending edit of `item`, if any. */
export function itemEdit(
  edits: DynamoEdits,
  item: Item,
  schema: KeySchema | null,
): PendingItemEdit | undefined {
  const key = schema ? itemKey(item, schema) : null
  return key ? edits[keyId(key)] : undefined
}

/** `item` with its pending values applied, for display. */
export function withPendingValues(item: Item, edit: PendingItemEdit | undefined): Item {
  if (!edit) return item
  const values = Object.entries(edit.changes).map(([name, change]) => [name, change.after])
  return { ...item, ...Object.fromEntries(values) }
}

export interface CellEditInput {
  /** The item as loaded (without pending values). */
  item: Item
  schema: KeySchema
  name: string
  text: string
}

/**
 * Stages (or, when the value is back to where it started, unstages) one cell edit. A missing
 * attribute left empty stays missing rather than becoming an empty string.
 */
export function stageCellEdit(edits: DynamoEdits, input: CellEditInput): Result<DynamoEdits> {
  const { item, schema, name, text } = input
  const key = itemKey(item, schema)
  if (!key) return { ok: false, error: "This item has no complete key, so it can't be edited" }
  const keyRole =
    name === schema.hash.name ? "partition" : name === schema.range?.name ? "sort" : null
  const type = inlineEditType(item[name], keyRole)
  if (!type) return { ok: false, error: `Edit ${name} in the item editor` }
  const id = keyId(key)
  const existing = edits[id]
  const before = existing?.changes[name] ? existing.changes[name].before : (item[name] ?? null)
  if (before === null && text === "") return { ok: true, value: unstage(edits, id, name) }
  const parsed = parseInlineValue(type, text)
  if (!parsed.ok) return parsed
  if (before && attributesEqual(before, parsed.value)) {
    return { ok: true, value: unstage(edits, id, name) }
  }
  const changes = { ...existing?.changes, [name]: { before, after: parsed.value } }
  return { ok: true, value: { ...edits, [id]: { key, changes } } }
}

function unstage(edits: DynamoEdits, id: string, name: string): DynamoEdits {
  const existing = edits[id]
  if (!existing?.changes[name]) return edits
  const changes = Object.fromEntries(Object.entries(existing.changes).filter(([n]) => n !== name))
  if (Object.keys(changes).length > 0) return { ...edits, [id]: { ...existing, changes } }
  return withoutItems(edits, [id])
}

/** Drops the edits of the given items, e.g. the ones that were written. */
export function withoutItems(edits: DynamoEdits, ids: readonly string[]): DynamoEdits {
  if (!ids.some((id) => id in edits)) return edits
  return Object.fromEntries(Object.entries(edits).filter(([id]) => !ids.includes(id)))
}

/** Marks the edits of items an Apply couldn't write with the kind of error it got. */
export function markFailed(
  edits: DynamoEdits,
  failures: Readonly<Record<string, AppErrorKind>>,
): DynamoEdits {
  return Object.fromEntries(
    Object.entries(edits).map(([id, edit]) =>
      failures[id] ? [id, { ...edit, failed: failures[id] }] : [id, edit],
    ),
  )
}

/**
 * Why a pending item wasn't written and what to do about it. A conditional write the server
 * refused is a `query` error: the item changed or was deleted since it was loaded (or IAM
 * refused the write), so the pending values hide what the server holds now.
 */
export function failedEditHint(kind: AppErrorKind): string {
  if (kind === "query") {
    return "Not written: the item changed on the server or the write was refused. Discard this item's changes to see its current values."
  }
  if (kind === "connection" || kind === "credential") {
    return "Not written: DynamoDB couldn't be reached. Apply again, or discard this item's changes."
  }
  return "Not written. Apply again, or discard this item's changes."
}

export interface ItemUpdate {
  id: string
  key: Item
  changes: AttributeUpdate[]
}

/** One conditional update per edited item, in the order the items were first edited. */
export function buildItemUpdates(edits: DynamoEdits): ItemUpdate[] {
  return Object.entries(edits).map(([id, edit]) => ({
    id,
    key: edit.key,
    changes: Object.entries(edit.changes).map(([name, change]) => ({
      name,
      value: change.after,
      expected: change.before,
    })),
  }))
}
