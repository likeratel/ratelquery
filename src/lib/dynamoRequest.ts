import type {
  AttributeValue,
  DynamoExportRequest,
  Item,
  KeySchema,
  KeyType,
  QueryRequest,
  RangeCondition,
  ScanRequest,
  TableDescription,
} from "./dynamo"
import {
  canonicalDecimal,
  inexactNumberLiterals,
  isBase64,
  plainToWire,
  type PlainValue,
  type Result,
} from "./dynamoJson"

export type DynamoMode = "scan" | "query"
export type RangeOp = RangeCondition["op"]

export const RANGE_OPS: readonly { op: RangeOp; label: string }[] = [
  { op: "eq", label: "=" },
  { op: "lt", label: "<" },
  { op: "le", label: "≤" },
  { op: "gt", label: ">" },
  { op: "ge", label: "≥" },
  { op: "begins_with", label: "begins with" },
  { op: "between", label: "between" },
]

/** Raw text of the scan / query form. Everything is converted only when a request is built. */
export interface DynamoForm {
  /** Index name; empty string targets the table itself. */
  index: string
  hash: string
  /** Empty string means no sort key condition. */
  rangeOp: RangeOp | ""
  rangeValue: string
  rangeTo: string
  filter: string
  /** One `#name = attribute` per line. */
  names: string
  /** One `:value = JSON` per line. */
  values: string
  limit: string
  scanForward: boolean
}

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000

export const EMPTY_FORM: DynamoForm = {
  index: "",
  hash: "",
  rangeOp: "",
  rangeValue: "",
  rangeTo: "",
  filter: "",
  names: "",
  values: "",
  limit: String(DEFAULT_LIMIT),
  scanForward: true,
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: string): Result<T> => ({ ok: false, error })

/** Key schema of the table or of one of its indexes; null when the index doesn't exist. */
export function indexKeySchema(description: TableDescription, index: string): KeySchema | null {
  if (index === "") return description.keySchema
  return description.indexes.find((i) => i.name === index)?.keySchema ?? null
}

/** Converts the text typed for a key attribute into a wire value of the key's type. */
export function keyValueToWire(text: string, type: KeyType, label: string): Result<AttributeValue> {
  if (type === "S") return text === "" ? fail(`Enter a value for ${label}`) : ok({ S: text })
  const trimmed = text.trim()
  if (trimmed === "") return fail(`Enter a value for ${label}`)
  if (type === "N") {
    return canonicalDecimal(trimmed) === null
      ? fail(`${label} is a number key; "${trimmed}" isn't a number`)
      : ok({ N: trimmed })
  }
  return isBase64(trimmed)
    ? ok({ B: trimmed })
    : fail(`${label} is a binary key; enter base64 text`)
}

interface Line {
  key: string
  value: string
  line: number
}

function splitLines(text: string, prefix: "#" | ":", what: string): Result<Line[]> {
  const lines: Line[] = []
  const rows = text.split("\n")
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i].trim()
    if (row === "") continue
    const eq = row.indexOf("=")
    const key = (eq === -1 ? row : row.slice(0, eq)).trim()
    if (eq === -1) return fail(`${what} line ${i + 1}: use ${prefix}placeholder = value`)
    if (!key.startsWith(prefix) || key.length < 2) {
      return fail(`${what} line ${i + 1}: placeholders start with ${prefix}`)
    }
    if (lines.some((l) => l.key === key)) return fail(`${what}: ${key} is defined twice`)
    lines.push({ key, value: row.slice(eq + 1).trim(), line: i + 1 })
  }
  return ok(lines)
}

/** Parses `#n = attr` lines into ExpressionAttributeNames. */
export function parseNames(text: string): Result<Record<string, string>> {
  const lines = splitLines(text, "#", "Names")
  if (!lines.ok) return lines
  const empty = lines.value.find((l) => l.value === "")
  if (empty) return fail(`Names line ${empty.line}: enter the attribute name for ${empty.key}`)
  return ok(Object.fromEntries(lines.value.map((l) => [l.key, l.value])))
}

const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/** Plain JSON value text to a wire attribute. Bare numeric literals keep their exact digits. */
export function valueTextToWire(text: string): Result<AttributeValue> {
  if (NUMBER_LITERAL.test(text)) return ok({ N: text })
  let parsed: PlainValue
  try {
    parsed = JSON.parse(text) as PlainValue
  } catch {
    return fail(`${text || "(empty)"} isn't valid JSON; quote strings like "text"`)
  }
  const inexact = inexactNumberLiterals(text)
  if (inexact.length > 0) return fail(`${inexact[0]} is too precise; write it as a bare number`)
  return ok(plainToWire(parsed))
}

/** Parses `:v = JSON` lines into ExpressionAttributeValues. */
export function parseValues(text: string): Result<Record<string, AttributeValue>> {
  const lines = splitLines(text, ":", "Values")
  if (!lines.ok) return lines
  const entries: [string, AttributeValue][] = []
  for (const line of lines.value) {
    const value = valueTextToWire(line.value)
    if (!value.ok) return fail(`Values line ${line.line} (${line.key}): ${value.error}`)
    entries.push([line.key, value.value])
  }
  return ok(Object.fromEntries(entries))
}

export function parseLimit(text: string): Result<number> {
  const trimmed = text.trim()
  if (trimmed === "") return ok(DEFAULT_LIMIT)
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    return fail(`Limit must be a whole number from 1 to ${MAX_LIMIT}`)
  }
  return ok(value)
}

interface CommonParts {
  index?: string
  filter?: string
  names?: Record<string, string>
  values?: Record<string, AttributeValue>
  limit: number
}

function commonParts(form: DynamoForm): Result<CommonParts> {
  const names = parseNames(form.names)
  if (!names.ok) return names
  const values = parseValues(form.values)
  if (!values.ok) return values
  const limit = parseLimit(form.limit)
  if (!limit.ok) return limit
  const filter = form.filter.trim()
  return ok({
    ...(form.index ? { index: form.index } : {}),
    ...(filter ? { filter } : {}),
    ...(Object.keys(names.value).length > 0 ? { names: names.value } : {}),
    ...(Object.keys(values.value).length > 0 ? { values: values.value } : {}),
    limit: limit.value,
  })
}

function rangeCondition(form: DynamoForm, schema: KeySchema): Result<RangeCondition | undefined> {
  if (form.rangeOp === "") return ok(undefined)
  const range = schema.range
  if (!range) return fail("This index has no sort key")
  const label = `sort key ${range.name}`
  if (form.rangeOp === "begins_with" && range.type === "N") {
    return fail("begins with needs a string or binary sort key")
  }
  const value = keyValueToWire(form.rangeValue, range.type, label)
  if (!value.ok) return value
  if (form.rangeOp !== "between") return ok({ op: form.rangeOp, value: value.value })
  const to = keyValueToWire(form.rangeTo, range.type, `the upper bound of ${label}`)
  if (!to.ok) return to
  return ok({ op: "between", from: value.value, to: to.value })
}

export interface BuildRequestInput {
  table: string
  mode: DynamoMode
  form: DynamoForm
  /** Needed for query key types; scans work without it. */
  description: TableDescription | null
}

/** Validates the form and builds the first-page request (no start key). */
export function buildDynamoRequest(input: BuildRequestInput): Result<DynamoExportRequest> {
  const { table, mode, form, description } = input
  const common = commonParts(form)
  if (!common.ok) return common
  if (mode === "scan") return ok({ scan: { table, ...common.value } })
  if (!description) return fail("Table details are still loading; try again in a moment")
  const schema = indexKeySchema(description, form.index)
  if (!schema) return fail(`Index ${form.index} doesn't exist on ${table}`)
  const hash = keyValueToWire(form.hash, schema.hash.type, `partition key ${schema.hash.name}`)
  if (!hash.ok) return hash
  const range = rangeCondition(form, schema)
  if (!range.ok) return range
  const query: QueryRequest = {
    table,
    ...common.value,
    hash: hash.value,
    ...(range.value ? { range: range.value } : {}),
    ...(form.scanForward ? {} : { scanForward: false }),
  }
  return ok({ query })
}

/** The same request continued from `startKey` (first page when null). */
export function withStartKey(
  request: DynamoExportRequest,
  startKey: Item | null,
): DynamoExportRequest {
  const extra = startKey ? { startKey } : {}
  if ("scan" in request) {
    const scan: ScanRequest = { ...request.scan, ...extra }
    return { scan }
  }
  const query: QueryRequest = { ...request.query, ...extra }
  return { query }
}
