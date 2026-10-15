import type { Cell } from "./mysql"

/** Cell tags a user can type a value for. */
export type CellKind = Exclude<Cell["t"], "null">

export interface EditColumn {
  name: string
  /** Result `typeName` ("INT") or schema `COLUMN_TYPE` ("tinyint(1)", "int unsigned"). */
  typeName: string
  nullable: boolean
}

export type ParseResult = { ok: true; cell: Cell } | { ok: false; error: string }

/** The literal a user types to set a cell to SQL NULL. Case-sensitive on purpose. */
export const NULL_INPUT = "NULL"

const INT_TYPES = ["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "year"]
const FLOAT_TYPES = ["float", "double", "real"]
const DECIMAL_TYPES = ["decimal", "numeric", "dec", "fixed"]
const DATETIME_TYPES = ["datetime", "timestamp"]
const BYTES_TYPES = [
  "blob",
  "tinyblob",
  "mediumblob",
  "longblob",
  "binary",
  "varbinary",
  "geometry",
  "point",
  "linestring",
  "polygon",
]

/** Maps a MySQL type name to the Cell tag the backend uses for it. */
export function cellKindForType(typeName: string): CellKind {
  const lower = typeName.trim().toLowerCase()
  const base = lower.split(/[\s(]/)[0] ?? ""
  if (base === "bool" || base === "boolean" || base === "bit") return "bool"
  if (base === "tinyint" && /^tinyint\(1\)/.test(lower)) return "bool"
  if (INT_TYPES.includes(base)) return "int"
  if (FLOAT_TYPES.includes(base)) return "float"
  if (DECIMAL_TYPES.includes(base)) return "decimal"
  if (base === "date") return "date"
  if (base === "time") return "time"
  if (DATETIME_TYPES.includes(base)) return "datetime"
  if (base === "json") return "json"
  if (BYTES_TYPES.includes(base)) return "bytes"
  return "str"
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^-?\d{1,3}:\d{2}:\d{2}(\.\d{1,6})?$/
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(\.\d{1,6})?)$/
const INT_RE = /^[+-]?\d+$/
const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/

const fail = (error: string): ParseResult => ({ ok: false, error })
const ok = (cell: Cell): ParseResult => ({ ok: true, cell })

function parseInteger(text: string, unsigned: boolean): ParseResult {
  if (!INT_RE.test(text)) return fail("Enter a whole number")
  const normalized = text.replace(/^\+/, "").replace(/^(-?)0+(?=\d)/, "$1")
  if (unsigned && normalized.startsWith("-") && normalized !== "-0") {
    return fail("This column is unsigned")
  }
  return ok({ t: "int", v: normalized === "-0" ? "0" : normalized })
}

function parseBool(text: string): ParseResult {
  const lower = text.toLowerCase()
  if (lower === "true" || lower === "1") return ok({ t: "bool", v: true })
  if (lower === "false" || lower === "0") return ok({ t: "bool", v: false })
  return fail("Enter true, false, 1 or 0")
}

function parseJson(text: string): ParseResult {
  try {
    JSON.parse(text)
    return ok({ t: "json", v: text })
  } catch {
    return fail("Enter valid JSON")
  }
}

function parseByKind(text: string, kind: CellKind, unsigned: boolean): ParseResult {
  if (kind === "str") return ok({ t: "str", v: text })
  const value = text.trim()
  if (kind === "json") return parseJson(value)
  if (kind === "bytes") return fail("Binary values can't be edited as text")
  if (value === "") return fail(`Enter a value or ${NULL_INPUT}`)
  switch (kind) {
    case "int":
      return parseInteger(value, unsigned)
    case "float": {
      const n = Number(value)
      return Number.isFinite(n) ? ok({ t: "float", v: n }) : fail("Enter a number")
    }
    case "decimal":
      return DECIMAL_RE.test(value)
        ? ok({ t: "decimal", v: value })
        : fail("Enter a decimal number")
    case "bool":
      return parseBool(value)
    case "date":
      return DATE_RE.test(value) ? ok({ t: "date", v: value }) : fail("Use YYYY-MM-DD")
    case "time":
      return TIME_RE.test(value) ? ok({ t: "time", v: value }) : fail("Use HH:MM:SS")
    case "datetime": {
      if (DATE_RE.test(value)) return ok({ t: "datetime", v: `${value} 00:00:00` })
      const match = DATETIME_RE.exec(value)
      return match
        ? ok({ t: "datetime", v: `${match[1]} ${match[2]}` })
        : fail("Use YYYY-MM-DD HH:MM:SS")
    }
  }
}

/**
 * Converts what the user typed into a Cell for `column`. `original` is the cell being edited,
 * when there is one; its tag wins over the type name because the backend already decided it
 * (for example `tinyint(1)` arriving as `bool`).
 */
export function parseCellInput(text: string, column: EditColumn, original?: Cell): ParseResult {
  if (text === NULL_INPUT) {
    return column.nullable ? ok({ t: "null" }) : fail(`${column.name} can't be NULL`)
  }
  const kind = original && original.t !== "null" ? original.t : cellKindForType(column.typeName)
  const unsigned = /\bunsigned\b/i.test(column.typeName)
  return parseByKind(text, kind, unsigned)
}

/** The text placed in the editor when a cell starts editing. */
export function cellToEditText(cell: Cell): string {
  switch (cell.t) {
    case "null":
      return NULL_INPUT
    case "bool":
      return cell.v ? "true" : "false"
    case "float":
      return String(cell.v)
    default:
      return cell.v
  }
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a.t === "null" || b.t === "null") return a.t === b.t
  return a.t === b.t && a.v === b.v
}
