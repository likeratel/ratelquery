import { rowsLabel } from "./applyPlan"
import type { ColumnInfo } from "./mysql"
import type { TrashEntry, TrashStatus, TrashSummary } from "./trash"
import type { RestoreOptions } from "./trash"

/** `deletedAt` in the local time zone, e.g. "2026-01-02 12:04:05". The raw text when it isn't a time. */
export function formatDeletedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** Entries whose connection, database, table or statement contains `query` (any case). */
export function filterTrash(entries: readonly TrashSummary[], query: string): TrashSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...entries]
  return entries.filter((entry) =>
    [
      entry.connectionName,
      entry.database,
      entry.table,
      `${entry.database}.${entry.table}`,
      entry.statement ?? "",
    ].some((text) => text.toLowerCase().includes(needle)),
  )
}

/** "3 rows · Grid" / "1 row · SQL". */
export function summaryLine(entry: Pick<TrashSummary, "rowCount" | "source">): string {
  return `${rowsLabel(entry.rowCount)} · ${entry.source === "grid" ? "Grid" : "SQL"}`
}

/** What a status means, for its badge; null for a plain committed entry. */
export function statusNote(status: TrashStatus): string | null {
  switch (status) {
    case "pending":
      return "Being saved by a delete that is still running"
    case "uncertain":
      return "The connection dropped while the delete was committed, or the app stopped: the rows may still be in the table. Check before restoring."
    case "committed":
      return null
  }
}

/** The sidebar label: "Trash" or "Trash (3)". */
export function trashLabel(count: number): string {
  return count > 0 ? `Trash (${count.toLocaleString("en-US")})` : "Trash"
}

/** The entry's columns as the grid shows them. */
export function trashColumns(entry: Pick<TrashEntry, "columns">): ColumnInfo[] {
  return entry.columns.map((c) => ({
    name: c.name,
    typeName: c.typeName,
    table: null,
    nullable: true,
  }))
}

/**
 * Restore options for the selected rows (`null`: all rows) and the chosen connection (left out
 * when it is the entry's own). Null when a selection was asked for but holds no row of the entry.
 */
export function restoreOptions(
  entry: Pick<TrashEntry, "connectionId" | "rows">,
  selected: ReadonlySet<number> | null,
  connectionId: string,
): RestoreOptions | null {
  const indexes = selected
    ? [...selected].filter((i) => i >= 0 && i < entry.rows.length).sort((a, b) => a - b)
    : []
  if (selected && indexes.length === 0) return null
  const all = indexes.length === 0 || indexes.length === entry.rows.length
  return {
    ...(all ? {} : { rowIndexes: indexes }),
    ...(connectionId && connectionId !== entry.connectionId ? { connectionId } : {}),
  }
}

/** How many rows `options` restores from `entry`. */
export function restoreCount(entry: Pick<TrashEntry, "rows">, options: RestoreOptions): number {
  return options.rowIndexes?.length ?? entry.rows.length
}

/**
 * The title of a failed restore's toast, by error kind and whether the table can roll back
 * (null: unknown, the preview didn't load). Only a known transactional table says nothing was
 * restored; the backend message in the detail always says what happened.
 */
export function restoreFailedTitle(kind: string, nonTransactional: boolean | null): string {
  if (kind === "connection") return "The restore may not have finished"
  if (nonTransactional === null) return "Restore failed"
  return nonTransactional ? "Restore failed; some rows may be restored" : "Nothing was restored"
}

/** The restore dialog's description, by what is known about the table's engine. */
export function restoreDescription(table: string, engine: string | null | undefined): string {
  if (engine)
    return `Into ${table}, one row after another: ${engine} can't undo rows already inserted.`
  if (engine === null)
    return `Into ${table}, in one transaction: nothing is restored if any row fails.`
  return `Into ${table}.`
}

/** The success toast after a restore. */
export function restoredMessage(restored: number, remaining: number): string {
  const base = `Restored ${rowsLabel(restored)}`
  return remaining > 0 ? `${base} · ${rowsLabel(remaining)} left in Trash` : base
}
