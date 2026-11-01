import type {
  AttributeUpdate,
  AttributeValue,
  ExpectedValue,
  Item,
  KeySchema,
  PathSegment,
} from "./dynamo"
import { attributesEqual, itemKey, type AttributeChange } from "./dynamoDiff"
import {
  attributeTag,
  canonicalDecimal,
  isExactNumber,
  jsonInString,
  jsonStringReadOnlyReason,
  type PlainValue,
  type Result,
} from "./dynamoJson"
import {
  attributeAt,
  formatPath,
  isPathPrefix,
  jsonAt,
  pathKey,
  withAttributeAt,
  withJsonAt,
} from "./dynamoPath"
import { attributeSummary, type KeyRole } from "./dynamoView"
import type { AppErrorKind } from "./ipc"

/**
 * Pending inline edits of DynamoDB values, from grid cells and the item tree, applied together
 * with one UpdateItem per item.
 *
 * Only scalar values are edited inline: S, N and BOOL keep their type, and a missing grid
 * attribute becomes a new S. The tree edits the same scalars at any depth of maps and lists,
 * and inside JSON stored in a string. Keys, NULL, B, sets and structural changes open the JSON
 * item editor instead. NULL has no single type to turn into when the user types something, so
 * it stays a JSON-editor edit rather than guessing one.
 *
 * Edits are keyed by the item's table key (not its row), so they survive a page refresh and
 * still describe the same item. Each change remembers the value it started from, and, for every
 * list index on its path, the whole list as loaded (see `listGuards`); the write is conditional
 * on all of them still being that. A list that shifted meanwhile therefore refuses the write
 * instead of changing another element.
 * After a refresh, a change those values no longer match is a conflict: it is shown but not
 * laid over the new item. A grid cell and a tree row showing the same value share one change,
 * so the two never compete.
 */

export type InlineType = "S" | "N" | "BOOL"

export interface PendingAttribute {
  /** The attribute name, then the map keys and list indexes down to the edited value. */
  path: readonly PathSegment[]
  /** Value when the edit started; null when the item didn't have the attribute. */
  before: AttributeValue | null
  after: AttributeValue
  /** Each list `path` indexes into, as loaded when the edit started (see `listGuards`). */
  guards?: readonly ValueGuard[]
}

/** A value at `path` the stored item must still hold for the change to be written. */
export interface ValueGuard {
  path: readonly PathSegment[]
  value: AttributeValue
}

export interface PendingItemEdit {
  key: Item
  /** By `pathKey` of the edited value. */
  changes: Readonly<Record<string, PendingAttribute>>
  /**
   * Error kind of the last Apply that couldn't write the item. It stays through later edits,
   * until the item is written or its changes are discarded.
   */
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

/** `actual` (undefined when missing) is `expected` (null when it should be missing). */
function holds(actual: AttributeValue | undefined, expected: AttributeValue | null): boolean {
  if (!actual || !expected) return !actual && !expected
  return attributesEqual(actual, expected)
}

/**
 * Changes that `item` (as loaded now, e.g. after a refresh) no longer matches: the value or a
 * list its path indexes into isn't what the edit started from, or the path leads nowhere. Their
 * write would be refused, and laying them over the item would show them in the wrong place.
 */
export function conflictingChanges(
  edit: PendingItemEdit | undefined,
  item: Item,
): PendingAttribute[] {
  return Object.values(edit?.changes ?? {}).filter(
    (change) =>
      !holds(attributeAt(item, change.path), change.before) ||
      (change.guards ?? []).some((guard) => !holds(attributeAt(item, guard.path), guard.value)),
  )
}

export const CONFLICT_HINT =
  "Not current: the item changed since these edits were made, so Apply will be refused. Discard this item's changes to see its current values."

/**
 * `item` with its pending values applied, for display. Conflicting changes are left out, so
 * the item shows what it holds now rather than a value at a shifted place.
 */
export function withPendingValues(item: Item, edit: PendingItemEdit | undefined): Item {
  if (!edit) return item
  const conflicts = new Set(conflictingChanges(edit, item))
  return Object.values(edit.changes).reduce((shown, change) => {
    if (conflicts.has(change)) return shown
    const { path, after } = change
    if (path.length === 1) return { ...shown, [path[0]]: after }
    return withAttributeAt(shown, path, after) ?? shown
  }, item)
}

/** An item's pending changes as diff rows named by path, for the review before Apply. */
export function pendingChangeList(edit: PendingItemEdit | undefined): AttributeChange[] {
  return Object.values(edit?.changes ?? {}).map(({ path, before, after }) => ({
    name: formatPath(path),
    id: pathKey(path),
    kind: before ? "changed" : "added",
    before,
    after,
  }))
}

/** The pending changes at `path` or inside it, e.g. to mark a grid cell or a tree row. */
export function changesUnder(
  edit: PendingItemEdit | undefined,
  path: readonly PathSegment[],
): PendingAttribute[] {
  if (!edit) return []
  return Object.values(edit.changes).filter((change) => isPathPrefix(path, change.path))
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
  const path = [name]
  const before = startingValue(edits[keyId(key)], item, path)
  if (before === null && text === "") return { ok: true, value: stageValue(edits, key, path, null) }
  const parsed = parseInlineValue(type, text)
  if (!parsed.ok) return parsed
  return { ok: true, value: stageValue(edits, key, path, parsed.value, before) }
}

/** The value an edit at `path` started from: the first edit's, else the loaded one. */
function startingValue(
  existing: PendingItemEdit | undefined,
  item: Item,
  path: readonly PathSegment[],
): AttributeValue | null {
  const change = existing?.changes[pathKey(path)]
  return change ? change.before : (attributeAt(item, path) ?? null)
}

/**
 * The lists `path` indexes into, each whole, as they were when the item's edits started: for
 * every index `path[k]`, the list `path.slice(0, k)`. An element's value says nothing about its
 * position (removing `[a, x, x][0]` leaves an equal `x` at index 1), so every list on the way is
 * guarded whole, in the middle of the path as at its end. Map keys don't shift and need none.
 * A guard an earlier change of the item already took is reused, else it comes from `item`.
 */
function listGuards(
  existing: PendingItemEdit | undefined,
  item: Item,
  path: readonly PathSegment[],
): ValueGuard[] | null {
  const earlier = new Map(
    Object.values(existing?.changes ?? {}).flatMap((change) =>
      (change.guards ?? []).map((guard) => [pathKey(guard.path), guard.value] as const),
    ),
  )
  const guards: ValueGuard[] = []
  for (let k = 1; k < path.length; k += 1) {
    if (typeof path[k] !== "number") continue
    const list = path.slice(0, k)
    const value = earlier.get(pathKey(list)) ?? attributeAt(item, list)
    if (!value) return null
    guards.push({ path: list, value })
  }
  return guards
}

/**
 * Stages `after` at `path`, or unstages it when `after` is null or back to `before`. The first
 * edit at `path` keeps its starting value and guards; the item's failure mark stays.
 */
function stageValue(
  edits: DynamoEdits,
  key: Item,
  path: readonly PathSegment[],
  after: AttributeValue | null,
  before: AttributeValue | null = null,
  guards: readonly ValueGuard[] = [],
): DynamoEdits {
  const id = keyId(key)
  const existing = edits[id]
  const changeId = pathKey(path)
  if (after === null || (before && attributesEqual(before, after))) {
    if (!existing?.changes[changeId]) return edits
    const changes = Object.fromEntries(
      Object.entries(existing.changes).filter(([k]) => k !== changeId),
    )
    if (Object.keys(changes).length > 0) return { ...edits, [id]: { ...existing, changes } }
    return withoutItems(edits, [id])
  }
  const kept = existing?.changes[changeId]?.guards ?? guards
  const change = { path, before, after, ...(kept.length > 0 ? { guards: kept } : {}) }
  const changes = { ...existing?.changes, [changeId]: change }
  return { ...edits, [id]: { ...existing, key, changes } }
}

/** How a JSON value inside a string is edited in place, or null when it isn't. */
export type JsonLeafType = "string" | "number" | "boolean"

export function jsonLeafType(value: PlainValue | undefined): JsonLeafType | null {
  const type = typeof value
  return type === "string" || type === "number" || type === "boolean" ? type : null
}

/**
 * Typed text to a JSON value of `type`. Numbers must survive `JSON.stringify` unchanged, so a
 * value beyond 2^53 or too precise is refused rather than rounded.
 */
export function parseJsonLeaf(type: JsonLeafType, text: string): Result<PlainValue> {
  if (type === "string") return { ok: true, value: text }
  if (type === "boolean") {
    const parsed = parseInlineValue("BOOL", text)
    return parsed.ok ? { ok: true, value: Boolean(parsed.value.BOOL) } : parsed
  }
  const trimmed = text.trim()
  if (canonicalDecimal(trimmed) === null) return { ok: false, error: `"${trimmed}" isn't a number` }
  if (!isExactNumber(trimmed)) {
    return { ok: false, error: `${trimmed} can't be stored exactly in JSON` }
  }
  return { ok: true, value: Number(trimmed) }
}

export interface TreeEditInput {
  /** The item as loaded (without pending values). */
  item: Item
  schema: KeySchema
  /** Where the edited value is: an S, N or BOOL, or the S holding the edited JSON. */
  path: readonly PathSegment[]
  /** Path inside the string's JSON; empty when the value at `path` itself is edited. */
  jsonPath: readonly PathSegment[]
  text: string
}

/**
 * Stages (or unstages) one value edited in the item tree, at any depth of maps and lists. An
 * edit inside JSON stored in a string rewrites the whole string as `JSON.stringify` of the
 * edited JSON, which the string allows only when that leaves everything else as it was.
 */
export function stageTreeEdit(edits: DynamoEdits, input: TreeEditInput): Result<DynamoEdits> {
  const { item, schema, path, jsonPath, text } = input
  const key = itemKey(item, schema)
  if (!key) return { ok: false, error: "This item has no complete key, so it can't be edited" }
  const [name] = path
  if (name === schema.hash.name || name === schema.range?.name) {
    return { ok: false, error: `${name} is part of the table key; edit it in the item editor` }
  }
  // An update path names each map key, and DynamoDB refuses an empty one there, so the write
  // would fail on Apply; JSON keys inside a string (`jsonPath`) are only text and are fine.
  if (path.slice(1).some((segment) => segment === "")) {
    return {
      ok: false,
      error:
        "This value is under an empty map key, which can't be edited in place; edit the item in the item editor",
    }
  }
  const existing = edits[keyId(key)]
  const before = startingValue(existing, item, path)
  const current = attributeAt(withPendingValues(item, existing), path)
  const guards = listGuards(existing, item, path)
  if (!before || !current || !guards) {
    return { ok: false, error: "This value is no longer in the item" }
  }
  const after =
    jsonPath.length === 0 ? parseValue(current, text) : parseInJson(before, current, input)
  if (!after.ok) return after
  return { ok: true, value: stageValue(edits, key, path, after.value, before, guards) }
}

function parseValue(current: AttributeValue, text: string): Result<AttributeValue> {
  const type = inlineEditType(current, null)
  return type
    ? parseInlineValue(type, text)
    : { ok: false, error: "Edit this value in the item editor" }
}

function parseInJson(
  before: AttributeValue,
  current: AttributeValue,
  { jsonPath, text }: TreeEditInput,
): Result<AttributeValue> {
  const loaded = attributeTag(before) === "S" ? jsonInString(String(before.S)) : null
  const shown = attributeTag(current) === "S" ? jsonInString(String(current.S)) : null
  if (!loaded || !shown) return { ok: false, error: "This value no longer holds JSON" }
  const reason = jsonStringReadOnlyReason(loaded) ?? jsonStringReadOnlyReason(shown)
  if (reason) return { ok: false, error: reason }
  const type = jsonLeafType(jsonAt(shown.value, jsonPath))
  if (!type) return { ok: false, error: "Edit this value in the item editor" }
  const leaf = parseJsonLeaf(type, text)
  if (!leaf.ok) return leaf
  const next = withJsonAt(shown.value, jsonPath, leaf.value)
  return next === null
    ? { ok: false, error: "This value is no longer in the item" }
    : { ok: true, value: { S: JSON.stringify(next) } }
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
  /** The lists the changed paths index into, each once. */
  expected: ExpectedValue[]
}

function toExpected(path: readonly PathSegment[], value: AttributeValue | null): ExpectedValue {
  const [name, ...rest] = path
  return { name: String(name), ...(rest.length > 0 ? { path: rest } : {}), value }
}

/** Expected values without repeats, e.g. one list guarded by several changes. */
function uniqueExpected(values: readonly ExpectedValue[]): ExpectedValue[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = JSON.stringify(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const guardsOf = (edit: PendingItemEdit) =>
  Object.values(edit.changes).flatMap((change) =>
    (change.guards ?? []).map((guard) => toExpected(guard.path, guard.value)),
  )

/**
 * One conditional update per edited item, in the order the items were first edited. `only`
 * limits it to some items, such as the one reviewed in the item panel.
 */
export function buildItemUpdates(edits: DynamoEdits, only?: readonly string[]): ItemUpdate[] {
  return Object.entries(edits)
    .filter(([id]) => !only || only.includes(id))
    .map(([id, edit]) => ({
      id,
      key: edit.key,
      changes: Object.values(edit.changes).map(({ path, after, before }) => {
        const { name, path: rest } = toExpected(path, null)
        return { name, ...(rest ? { path: rest } : {}), value: after, expected: before }
      }),
      expected: uniqueExpected(guardsOf(edit)),
    }))
}

/**
 * What an item's pending changes started from: each edited value and each list its path
 * indexes into. The item editor takes the changes over and saves only while all of them still hold.
 */
export function carriedExpectations(edit: PendingItemEdit): ExpectedValue[] {
  const befores = Object.values(edit.changes).map((change) =>
    toExpected(change.path, change.before),
  )
  return uniqueExpected([...befores, ...guardsOf(edit)])
}
