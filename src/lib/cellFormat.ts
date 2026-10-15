import type { Cell, ColumnInfo } from "./mysql"

/** Colour family for a cell; maps to the `--data-*` tokens. */
export type CellTone = "number" | "string" | "bool" | "null" | "date" | "json" | "bytes"

const MAX_DISPLAY_CHARS = 400

export function cellTone(cell: Cell): CellTone {
  switch (cell.t) {
    case "null":
      return "null"
    case "int":
    case "float":
    case "decimal":
      return "number"
    case "bool":
      return "bool"
    case "date":
    case "time":
    case "datetime":
      return "date"
    case "json":
      return "json"
    case "bytes":
      return "bytes"
    case "str":
      return "string"
  }
}

/** Decoded length of a base64 string without decoding it. */
export function base64ByteLength(value: string): number {
  const clean = value.replace(/\s/g, "")
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

/** Single-line text shown in a grid cell. */
export function formatCell(cell: Cell): string {
  switch (cell.t) {
    case "null":
      return "NULL"
    case "bool":
      return cell.v ? "true" : "false"
    case "float":
      return String(cell.v)
    case "bytes":
      return `(binary, ${base64ByteLength(cell.v)} bytes)`
    default: {
      const flat =
        cell.v.length > MAX_DISPLAY_CHARS ? `${cell.v.slice(0, MAX_DISPLAY_CHARS)}…` : cell.v
      return flat.replace(/[\r\n\t]+/g, " ")
    }
  }
}

const CHAR_PX = 7.6
const PADDING_PX = 24
const MIN_WIDTH = 64
const MAX_WIDTH = 360
const SAMPLE_ROWS = 50

/** Starting width for a column, from its header and the first rows. */
export function initialColumnWidth(
  column: ColumnInfo,
  rows: readonly Cell[][],
  index: number,
): number {
  const headerChars = Math.max(column.name.length, column.typeName.length * 0.8 + 2)
  const sampleChars = rows
    .slice(0, SAMPLE_ROWS)
    .reduce((max, row) => Math.max(max, formatCell(row[index] ?? { t: "null" }).length), 0)
  const width = Math.max(headerChars, sampleChars) * CHAR_PX + PADDING_PX
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
