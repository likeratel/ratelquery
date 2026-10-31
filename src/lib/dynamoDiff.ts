import type { AttributeValue, Item, KeySchema, PutExpectation } from "./dynamo"
import { attributeTag, canonicalDecimal } from "./dynamoJson"

export type ChangeKind = "added" | "changed" | "removed"

export interface AttributeChange {
  name: string
  /** Stable row identity when `name` is a display path (see `pendingChangeList`). */
  id?: string
  kind: ChangeKind
  before: AttributeValue | null
  after: AttributeValue | null
}

const sortedStrings = (values: unknown, normalize: (v: string) => string = (v) => v) =>
  Array.isArray(values) ? values.map((v) => normalize(String(v))).sort() : []

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** Value equality in DynamoDB terms: numbers by value, sets ignoring order. */
export function attributesEqual(a: AttributeValue, b: AttributeValue): boolean {
  const tag = attributeTag(a)
  if (tag === null || tag !== attributeTag(b)) return JSON.stringify(a) === JSON.stringify(b)
  const left = a[tag]
  const right = b[tag]
  switch (tag) {
    case "N": {
      const l = canonicalDecimal(String(left))
      const r = canonicalDecimal(String(right))
      // Two values that aren't decimals at all are only equal when written the same way.
      return l === null && r === null ? String(left) === String(right) : l === r
    }
    case "SS":
    case "BS":
      return sameList(sortedStrings(left), sortedStrings(right))
    case "NS": {
      const normalize = (v: string) => canonicalDecimal(v) ?? v
      return sameList(sortedStrings(left, normalize), sortedStrings(right, normalize))
    }
    case "M":
      return itemsEqual(left as Item, right as Item)
    case "L": {
      const l = left as AttributeValue[]
      const r = right as AttributeValue[]
      return l.length === r.length && l.every((v, i) => attributesEqual(v, r[i]))
    }
    default:
      return left === right
  }
}

function itemsEqual(a: Item, b: Item): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => k in b && attributesEqual(a[k], b[k]))
  )
}

/** Per-attribute differences, in the original attribute order followed by new attributes. */
export function diffItems(original: Item | null, edited: Item): AttributeChange[] {
  const before = original ?? {}
  const names = [...Object.keys(before), ...Object.keys(edited).filter((k) => !(k in before))]
  return names.flatMap((name): AttributeChange[] => {
    const was = before[name] ?? null
    const now = edited[name] ?? null
    if (was && now) {
      return attributesEqual(was, now) ? [] : [{ name, kind: "changed", before: was, after: now }]
    }
    if (now) return [{ name, kind: "added", before: null, after: now }]
    return [{ name, kind: "removed", before: was, after: null }]
  })
}

/** The key attributes of an item, or null when one is missing. */
export function itemKey(item: Item, schema: KeySchema): Item | null {
  const attrs = schema.range ? [schema.hash, schema.range] : [schema.hash]
  if (attrs.some((a) => !item[a.name])) return null
  return Object.fromEntries(attrs.map((a) => [a.name, item[a.name]]))
}

/** Error message when the item lacks a key attribute or has one of the wrong type. */
export function validateKeyAttributes(item: Item, schema: KeySchema): string | null {
  const attrs = schema.range
    ? [
        { ...schema.hash, role: "partition" },
        { ...schema.range, role: "sort" },
      ]
    : [{ ...schema.hash, role: "partition" }]
  for (const attr of attrs) {
    const value = item[attr.name]
    if (!value) return `Missing ${attr.role} key ${attr.name} (${attr.type})`
    const tag = attributeTag(value)
    if (tag !== attr.type) {
      return `${attr.role[0].toUpperCase()}${attr.role.slice(1)} key ${attr.name} must be ${attr.type}, not ${tag ?? "unknown"}`
    }
  }
  return null
}

export function keyChanged(original: Item, edited: Item, schema: KeySchema): boolean {
  const before = itemKey(original, schema)
  const after = itemKey(edited, schema)
  if (!before || !after) return true
  return !itemsEqual(before, after)
}

/**
 * Safe-write condition: an unchanged key overwrites the existing item only if it still exists;
 * a new item or a changed key must not overwrite anything.
 */
export function putExpectation(
  original: Item | null,
  edited: Item,
  schema: KeySchema,
): PutExpectation {
  return original && !keyChanged(original, edited, schema) ? "exists" : "not_exists"
}

export function sameKey(a: Item, b: Item, schema: KeySchema): boolean {
  return !keyChanged(a, b, schema)
}
