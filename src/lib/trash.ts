import type { Cell, ColumnInfo } from "./mysql"
import { ipc } from "./ipc"

/**
 * `pending`: saved before the delete ran, its transaction not finished. `committed`: the delete
 * was committed. `uncertain`: the connection dropped during COMMIT or the app stopped first, so
 * the rows may or may not still exist.
 */
export type TrashStatus = "pending" | "committed" | "uncertain"

/** Grid edits, or a DELETE statement run from the editor. */
export type TrashSource = "grid" | "sql"

export type TrashColumn = Pick<ColumnInfo, "name" | "typeName">

interface TrashFields {
  /** Lower-case hyphenated UUID. */
  id: string
  status: TrashStatus
  /** UTC RFC 3339 with milliseconds. */
  deletedAt: string
  connectionId: string
  /** The connection's name when the rows were deleted. */
  connectionName: string
  database: string
  table: string
  source: TrashSource
  /** The statement that deleted the rows, for `sql` entries. */
  statement: string | null
  columns: TrashColumn[]
  /** Primary key column names, in table order. */
  primaryKey: string[]
}

export interface TrashSummary extends TrashFields {
  rowCount: number
}

export interface TrashEntry extends TrashFields {
  /** In `columns` order. */
  rows: Cell[][]
}

/** Which rows to restore (all when absent) and through which MySQL connection (the entry's own when absent). */
export interface RestoreOptions {
  rowIndexes?: number[]
  connectionId?: string
}

export interface RestoreResult {
  restoredRows: number
  /** Rows still in the entry; 0 when it was removed. */
  remainingRows: number
  /** Set when the rows were restored but the entry couldn't be updated. */
  warning: string | null
}

/** `trash_restore_preview`: the first 200 INSERTs and how many there are. */
export interface RestorePreview {
  statements: string[]
  total: number
  /** Set (statements empty) when the connection's character set makes the text unsafe. */
  warning: string | null
  /** MyISAM and the like: a failing row leaves the rows before it restored. */
  nonTransactionalEngine: string | null
}

export const trashApi = {
  /** Newest first, without rows. Unreadable entries are skipped. */
  list: () => ipc<TrashSummary[]>("trash_list"),
  /** Rejects with `not_found` for an unknown id and `invalid_input` for a malformed one. */
  get: (id: string) => ipc<TrashEntry>("trash_get", { id }),
  delete: (id: string) => ipc<void>("trash_delete", { id }),
  /** Removes every entry except deletes still running; resolves to how many were removed. */
  empty: () => ipc<number>("trash_empty"),
  /** Removes entries older than `query.trashRetentionDays`; resolves to how many were removed. */
  purge: () => ipc<number>("trash_purge"),
  /**
   * Inserts the rows back in one transaction (nothing on any failure), then removes them from
   * the entry. Rejects with `connection` when the target connection isn't open.
   */
  restore: (id: string, options: RestoreOptions = {}) =>
    ipc<RestoreResult>("trash_restore", { id, options }),
  /** The INSERTs `restore` would run. Runs nothing. */
  restorePreview: (id: string, options: RestoreOptions = {}) =>
    ipc<RestorePreview>("trash_restore_preview", { id, options }),
}
