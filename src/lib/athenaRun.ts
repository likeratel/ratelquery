/**
 * Pure helpers for running SQL on Athena, which takes one statement per query execution: the
 * frontend splits a script and runs its statements one after another.
 */
import { splitStatements } from "./sqlContext"

/** A statement as Athena should get it: trimmed, without its terminating `;`. */
export function executedStatement(text: string): string {
  const trimmed = text.trim()
  return (trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed).trim()
}

/**
 * Every non-empty statement of `sql`, in order, ready for `athena_start`. Splits on `;` outside
 * strings, quoted identifiers and comments, with the same rule as the MySQL editor, so the
 * result index of a statement matches its position here.
 */
export function athenaStatements(sql: string): string[] {
  return splitStatements(sql)
    .map(({ text }) => executedStatement(text))
    .filter((text) => text !== "")
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const

/** Bytes scanned in binary units, e.g. `0 B`, `512 B`, `1.5 KB`, `12.3 GB`. */
export function formatDataSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`
}
