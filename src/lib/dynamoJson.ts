import type { AttributeValue, Item } from "./dynamo"

/**
 * Conversions between the DynamoDB JSON wire format (`{ S: "a" }`, `{ N: "1" }`, ...) and plain
 * JSON. Plain JSON is friendlier to read and edit but cannot express sets, binary or numbers
 * beyond double precision; `findLossyAttributes` reports those so plain editing can be refused.
 */

export type PlainValue = null | boolean | number | string | PlainValue[] | PlainObject
export interface PlainObject {
  [key: string]: PlainValue
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export const WIRE_TAGS = ["S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"] as const
export type WireTag = (typeof WIRE_TAGS)[number]

const TAG_SET: ReadonlySet<string> = new Set(WIRE_TAGS)

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: string): Result<T> => ({ ok: false, error })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The single type tag of a wire attribute, or null when it isn't a well-formed attribute. */
export function attributeTag(value: AttributeValue): WireTag | null {
  const keys = Object.keys(value)
  if (keys.length !== 1 || !TAG_SET.has(keys[0])) return null
  return keys[0] as WireTag
}

export function isBase64(text: string): boolean {
  return BASE64.test(text)
}

/**
 * Canonical `digits e exponent` form of a decimal string, so "1.50" and "15e-1" compare equal.
 * Returns null when the text isn't a decimal number.
 */
export function canonicalDecimal(text: string): string | null {
  const match = DECIMAL.exec(text.trim())
  if (!match) return null
  const [, sign, whole, fraction = "", exponentText = "0"] = match
  if (whole === "" && fraction === "") return null
  const allDigits = (whole + fraction).replace(/^0+/, "")
  if (allDigits === "") return "0"
  const digits = allDigits.replace(/0+$/, "")
  const exponent = Number(exponentText) - fraction.length + (allDigits.length - digits.length)
  return `${sign === "-" ? "-" : ""}${digits}e${exponent}`
}

/** True when a DynamoDB number survives a round trip through a JS number unchanged. */
export function isExactNumber(text: string): boolean {
  const canonical = canonicalDecimal(text)
  if (canonical === null) return false
  const value = Number(text)
  return Number.isFinite(value) && canonicalDecimal(String(value)) === canonical
}

/** Wire attribute to plain JSON. Inexact numbers stay strings; sets become arrays. */
export function wireToPlain(value: AttributeValue): PlainValue {
  const tag = attributeTag(value)
  const inner = tag ? value[tag] : undefined
  switch (tag) {
    case "S":
    case "B":
      return String(inner)
    case "N":
      return isExactNumber(String(inner)) ? Number(inner) : String(inner)
    case "BOOL":
      return Boolean(inner)
    case "NULL":
      return null
    case "M":
      return isRecord(inner) ? itemToPlain(inner as Item) : {}
    case "L":
      return Array.isArray(inner) ? inner.map((v) => wireToPlain(v as AttributeValue)) : []
    case "SS":
    case "BS":
      return Array.isArray(inner) ? inner.map(String) : []
    case "NS":
      return Array.isArray(inner)
        ? inner.map((n) => (isExactNumber(String(n)) ? Number(n) : String(n)))
        : []
    case null:
      return value as PlainObject
  }
}

export function itemToPlain(item: Item): PlainObject {
  return Object.fromEntries(Object.entries(item).map(([name, v]) => [name, wireToPlain(v)]))
}

/** Plain JSON to wire: number → N, string → S, boolean → BOOL, null → NULL, array → L, object → M. */
export function plainToWire(value: PlainValue): AttributeValue {
  if (value === null) return { NULL: true }
  if (typeof value === "boolean") return { BOOL: value }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${value} isn't a valid DynamoDB number`)
    return { N: String(value) }
  }
  if (typeof value === "string") return { S: value }
  if (Array.isArray(value)) return { L: value.map(plainToWire) }
  return { M: plainToItem(value) }
}

export function plainToItem(value: PlainObject): Item {
  return Object.fromEntries(Object.entries(value).map(([name, v]) => [name, plainToWire(v)]))
}

export interface LossyAttribute {
  /** Attribute path such as `tags` or `meta.history[2]`. */
  path: string
  type: string
  reason: string
}

const LOSSY_REASONS: Partial<Record<WireTag, string>> = {
  SS: "String sets become lists in plain mode",
  NS: "Number sets become lists in plain mode",
  BS: "Binary sets become lists in plain mode",
  B: "Binary values become strings in plain mode",
}

function lossyIn(value: AttributeValue, path: string): LossyAttribute[] {
  const tag = attributeTag(value)
  if (tag === null) return [{ path, type: "?", reason: "Unknown attribute type" }]
  const reason = LOSSY_REASONS[tag]
  if (reason) return [{ path, type: tag, reason }]
  if (tag === "N" && !isExactNumber(String(value.N))) {
    return [{ path, type: tag, reason: "Number is too precise for plain JSON" }]
  }
  if (tag === "M" && isRecord(value.M)) {
    return Object.entries(value.M).flatMap(([name, v]) =>
      lossyIn(v as AttributeValue, `${path}.${name}`),
    )
  }
  if (tag === "L" && Array.isArray(value.L)) {
    return value.L.flatMap((v, i) => lossyIn(v as AttributeValue, `${path}[${i}]`))
  }
  return []
}

/** Attributes that plain mode would change on save. Empty means plain editing is safe. */
export function findLossyAttributes(item: Item): LossyAttribute[] {
  return Object.entries(item).flatMap(([name, value]) => lossyIn(value, name))
}

function validateSet(inner: unknown, path: string, check: (v: string) => boolean, what: string) {
  if (!Array.isArray(inner) || inner.length === 0) return `${path}: a set needs at least one value`
  if (!inner.every((v) => typeof v === "string" && check(v))) {
    return `${path}: every value must be a ${what} string`
  }
  const normalized = inner.map((v) => (what === "number" ? canonicalDecimal(v) : v))
  if (new Set(normalized).size !== inner.length) return `${path}: sets can't contain duplicates`
  return null
}

/** Returns an error message for a malformed wire attribute, or null when it is valid. */
export function validateAttribute(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path}: expected an attribute such as {"S": "text"}`
  const tag = attributeTag(value)
  if (tag === null) {
    return `${path}: expected exactly one type key (${WIRE_TAGS.join(", ")})`
  }
  const inner = value[tag]
  switch (tag) {
    case "S":
      return typeof inner === "string" ? null : `${path}: S must be a string`
    case "N":
      return typeof inner === "string" && canonicalDecimal(inner) !== null
        ? null
        : `${path}: N must be a number in a string, e.g. {"N": "42"}`
    case "B":
      return typeof inner === "string" && isBase64(inner) ? null : `${path}: B must be base64`
    case "BOOL":
      return typeof inner === "boolean" ? null : `${path}: BOOL must be true or false`
    case "NULL":
      return inner === true ? null : `${path}: NULL must be true`
    case "M":
      if (!isRecord(inner)) return `${path}: M must be an object of attributes`
      return firstError(Object.entries(inner).map(([k, v]) => [v, `${path}.${k}`]))
    case "L":
      if (!Array.isArray(inner)) return `${path}: L must be an array of attributes`
      return firstError(inner.map((v, i) => [v, `${path}[${i}]`]))
    case "SS":
      return validateSet(inner, path, () => true, "")
    case "NS":
      return validateSet(inner, path, (v) => canonicalDecimal(v) !== null, "number")
    case "BS":
      return validateSet(inner, path, isBase64, "base64")
  }
}

function firstError(entries: [unknown, string][]): string | null {
  for (const [value, path] of entries) {
    const error = validateAttribute(value, path)
    if (error) return error
  }
  return null
}

function parseJson(text: string): Result<unknown> {
  try {
    return ok(JSON.parse(text))
  } catch (error) {
    return fail(error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON")
  }
}

/** Parses an item in wire format and validates every attribute. */
export function parseWireItem(text: string): Result<Item> {
  const parsed = parseJson(text)
  if (!parsed.ok) return parsed
  if (!isRecord(parsed.value)) return fail("An item must be a JSON object")
  const error = firstError(Object.entries(parsed.value).map(([k, v]) => [v, k]))
  return error ? fail(error) : ok(parsed.value as Item)
}

const NUMBER_OR_STRING = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/** Number literals in JSON text that `JSON.parse` would round. */
export function inexactNumberLiterals(text: string): string[] {
  return [...text.matchAll(NUMBER_OR_STRING)]
    .map((match) => match[0])
    .filter((token) => !token.startsWith('"') && !isExactNumber(token))
}

/** Parses a plain JSON object and converts it to a wire item. */
export function parsePlainItem(text: string): Result<Item> {
  const parsed = parseJson(text)
  if (!parsed.ok) return parsed
  if (!isRecord(parsed.value)) return fail("An item must be a JSON object")
  const inexact = inexactNumberLiterals(text)
  if (inexact.length > 0) {
    return fail(`${inexact[0]} can't be stored exactly from plain JSON. Switch to wire mode.`)
  }
  return ok(plainToItem(parsed.value as PlainObject))
}

export type JsonMode = "plain" | "wire"

export function formatItem(item: Item, mode: JsonMode): string {
  return JSON.stringify(mode === "plain" ? itemToPlain(item) : item, null, 2)
}

export function parseItem(text: string, mode: JsonMode): Result<Item> {
  return mode === "plain" ? parsePlainItem(text) : parseWireItem(text)
}
