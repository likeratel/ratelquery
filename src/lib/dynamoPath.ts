import type { AttributeValue, Item, PathSegment } from "./dynamo"
import { attributeTag, type PlainValue } from "./dynamoJson"

/**
 * Paths into an item: the attribute name, then a map key (string) or list index (number) per
 * level, like DynamoDB document paths. The same shape walks JSON parsed out of a string value.
 */

/** Stable identity of a path; `["a", 0]` and `["a", "0"]` stay apart. */
export function pathKey(path: readonly PathSegment[]): string {
  return JSON.stringify(path)
}

/** `current` once the leaf at `path` lets go of it: null if `path` holds it, else unchanged. */
export function releasedPath(
  current: readonly PathSegment[] | null,
  path: readonly PathSegment[],
): readonly PathSegment[] | null {
  return current && pathKey(current) === pathKey(path) ? null : current
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * Readable path such as `senderService.numbers[0].senderNumber`. Names that aren't identifiers
 * are quoted, so an attribute named `a.b` (`["a.b"]`) never reads like `a` → `b`.
 */
export function formatPath(path: readonly PathSegment[]): string {
  return path
    .map((segment, i) => {
      if (typeof segment === "number") return `[${segment}]`
      if (!IDENTIFIER.test(segment)) return `[${JSON.stringify(segment)}]`
      return i === 0 ? segment : `.${segment}`
    })
    .join("")
}

const NAME = /[A-Za-z_$][\w$]*/y
const INDEX = /\[(\d+)\]/y
const QUOTED = /\[("(?:[^"\\]|\\.)*")\]/y

/** The match of the sticky `pattern` at `at`, or null. */
function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at
  return pattern.exec(text)
}

function parseQuoted(literal: string): string | null {
  try {
    return JSON.parse(literal) as string
  } catch {
    return null
  }
}

/**
 * Reads a path written the way `formatPath` writes it (`a.b[0]`, `["a-b"][2]`), or null when
 * `text` isn't one. Nothing else is accepted, so a path reads back exactly as it was shown.
 */
export function parsePath(text: string): PathSegment[] | null {
  const path: PathSegment[] = []
  let at = 0
  while (at < text.length) {
    const index = matchAt(INDEX, text, at)
    const quoted = index ? null : matchAt(QUOTED, text, at)
    if (index) {
      const n = Number(index[1])
      if (!Number.isSafeInteger(n)) return null
      path.push(n)
      at += index[0].length
    } else if (quoted) {
      const key = parseQuoted(quoted[1])
      if (key === null) return null
      path.push(key)
      at += quoted[0].length
    } else {
      // A bare name starts the path; later names follow a dot.
      const dot = path.length > 0
      if (dot && text[at] !== ".") return null
      const name = matchAt(NAME, text, dot ? at + 1 : at)
      if (!name) return null
      path.push(name[0])
      at = NAME.lastIndex
    }
  }
  return path.length > 0 ? path : null
}

/** True when `prefix` is `path` itself or one of its ancestors. */
export function isPathPrefix(prefix: readonly PathSegment[], path: readonly PathSegment[]) {
  return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i])
}

function childOf(value: AttributeValue, segment: PathSegment): AttributeValue | undefined {
  const tag = attributeTag(value)
  if (tag === "M" && typeof segment === "string") {
    const map = value.M as Record<string, AttributeValue>
    return Object.hasOwn(map, segment) ? map[segment] : undefined
  }
  if (tag === "L" && typeof segment === "number") return (value.L as AttributeValue[])[segment]
  return undefined
}

/** The attribute at `path`, or undefined when the item has nothing there. */
export function attributeAt(item: Item, path: readonly PathSegment[]): AttributeValue | undefined {
  const [name, ...rest] = path
  if (typeof name !== "string" || !Object.hasOwn(item, name)) return undefined
  let value: AttributeValue | undefined = item[name]
  for (const segment of rest) {
    if (!value) return undefined
    value = childOf(value, segment)
  }
  return value
}

function withChild(
  value: AttributeValue,
  [segment, ...rest]: readonly PathSegment[],
  next: AttributeValue,
): AttributeValue | null {
  const child = childOf(value, segment)
  if (child === undefined) return null
  const replaced = rest.length === 0 ? next : withChild(child, rest, next)
  if (replaced === null) return null
  return typeof segment === "number"
    ? { L: (value.L as AttributeValue[]).with(segment, replaced) }
    : { M: { ...(value.M as Item), [segment]: replaced } }
}

/**
 * `item` with the existing value at `path` replaced by `next`, or null when the path doesn't
 * lead to a value. Nothing is mutated.
 */
export function withAttributeAt(
  item: Item,
  path: readonly PathSegment[],
  next: AttributeValue,
): Item | null {
  const [name, ...rest] = path
  if (typeof name !== "string" || !Object.hasOwn(item, name)) return null
  const replaced = rest.length === 0 ? next : withChild(item[name], rest, next)
  return replaced === null ? null : { ...item, [name]: replaced }
}

function jsonChild(value: PlainValue, segment: PathSegment): PlainValue | undefined {
  if (Array.isArray(value)) return typeof segment === "number" ? value[segment] : undefined
  if (value === null || typeof value !== "object" || typeof segment !== "string") return undefined
  return Object.hasOwn(value, segment) ? value[segment] : undefined
}

/** The JSON value at `path`, or undefined when there is none. */
export function jsonAt(value: PlainValue, path: readonly PathSegment[]): PlainValue | undefined {
  let current: PlainValue | undefined = value
  for (const segment of path) {
    if (current === undefined) return undefined
    current = jsonChild(current, segment)
  }
  return current
}

/** `value` with the existing JSON value at `path` replaced, or null when there is none. */
export function withJsonAt(
  value: PlainValue,
  path: readonly PathSegment[],
  next: PlainValue,
): PlainValue | null {
  if (path.length === 0) return next
  const [segment, ...rest] = path
  const child = jsonChild(value, segment)
  if (child === undefined) return null
  const replaced = withJsonAt(child, rest, next)
  if (replaced === null) return null
  if (Array.isArray(value)) return value.with(segment as number, replaced)
  return { ...(value as Record<string, PlainValue>), [segment]: replaced }
}
