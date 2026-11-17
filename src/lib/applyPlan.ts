import type { RowChange } from "./mysql"

/** How many changes of each kind a grid apply sends. */
export interface ChangeCounts {
  updates: number
  deletes: number
  inserts: number
}

/** Most SQL statements the apply dialog lists; the rest are summed up as "and N more". */
export const PREVIEW_LIMIT = 200

export function countChanges(changes: readonly RowChange[]): ChangeCounts {
  return {
    updates: changes.filter((c) => c.type === "update").length,
    deletes: changes.filter((c) => c.type === "delete").length,
    inserts: changes.filter((c) => c.type === "insert").length,
  }
}

/** Updates and deletes change existing rows, so they are confirmed first; inserts alone are not. */
export function needsApplyConfirm(counts: ChangeCounts): boolean {
  return counts.updates + counts.deletes > 0
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

export const rowsLabel = (count: number) => plural(count, "row")

/** "2 updates · 1 delete · 1 insert", leaving out kinds with none. */
export function describeCounts(counts: ChangeCounts): string {
  const parts = [
    counts.updates > 0 ? plural(counts.updates, "update") : null,
    counts.deletes > 0 ? plural(counts.deletes, "delete") : null,
    counts.inserts > 0 ? plural(counts.inserts, "insert") : null,
  ]
  return parts.filter((part) => part !== null).join(" · ")
}

/** Where deleted rows go, for the apply dialog. */
export function trashNote(deletes: number, retentionDays: number): string {
  return `${rowsLabel(deletes)} will be kept in Trash for ${plural(retentionDays, "day")} (Settings › Queries › Empty trash after).`
}

/** The statements to list, and how many are left out. */
export function previewSlice(
  statements: readonly string[],
  limit = PREVIEW_LIMIT,
): { shown: readonly string[]; hidden: number } {
  return { shown: statements.slice(0, limit), hidden: Math.max(0, statements.length - limit) }
}

/** Whether deleted rows were saved to the trash (`kept`) or deleted without a backup. */
export type BackupOutcome = "kept" | "skipped"

/** The success toast after an apply. */
export function appliedMessage(
  affectedRows: number,
  deletes: number,
  backup: BackupOutcome,
): string {
  const base = `Applied changes · ${rowsLabel(affectedRows)} affected`
  if (deletes === 0) return base
  return backup === "kept"
    ? `${base} · ${rowsLabel(deletes)} moved to Trash`
    : `${base} · ${rowsLabel(deletes)} deleted without a backup`
}

/** Why an answered dialog no longer applies (see `applyActiveEdits`). */
export type ApplyStaleReason = "gone" | "changed"

export function staleApplyMessage(reason: ApplyStaleReason): string {
  return reason === "gone"
    ? "The tab or result was closed while the dialog was open. Nothing was applied."
    : "The changes were edited while the dialog was open. Review them and apply again."
}

/** Apply waits for the SQL preview; a failed preview or a warning still allows it. */
export function canConfirmApply(preview: { status: "loading" | "ready" | "error" }): boolean {
  return preview.status !== "loading"
}

/** Added to a preview warning when the batch deletes rows (the backup is refused too). */
export function previewWarningNote(deletes: number): string | null {
  return deletes > 0
    ? "The deleted rows can't be backed up in this character set either: after Apply you'll be asked whether to delete without a backup."
    : null
}

/**
 * The title of a failed apply's toast. A lost COMMIT leaves the outcome open, and a table that
 * can't roll back (MyISAM) keeps the changes before the failing one, so only the backend's
 * message (the toast detail) says what happened; the title doesn't claim a rollback.
 */
export function applyFailedTitle(kind: string): string {
  return kind === "connection"
    ? "The changes may not have been applied"
    : "Couldn't apply the changes"
}
