import { rowsLabel } from "./applyPlan"
import type {
  BackupStoppedResult,
  DeletePlanEntry,
  ExecResult,
  QueryResponseItem,
  QueryResult,
} from "./mysql"

/** Longest statement text shown in the trash dialogs before it is cut. */
export const STATEMENT_PREVIEW_CHARS = 160

/** The results of a `mysql_query` response, and the backup stop that ended it, if any. */
export function splitBackupStop(items: readonly QueryResponseItem[]): {
  results: QueryResult[]
  stop: BackupStoppedResult | null
} {
  const results = items.filter((item): item is QueryResult => item.kind !== "backup_stopped")
  const stop = items.find((item): item is BackupStoppedResult => item.kind === "backup_stopped")
  return { results, stop: stop ?? null }
}

/** Cheap check before asking the backend: only text with the word DELETE can delete rows. */
export function mayDelete(sql: string): boolean {
  return /\bdelete\b/i.test(sql)
}

export function unsupportedDeletes(plan: readonly DeletePlanEntry[]): DeletePlanEntry[] {
  return plan.filter((entry) => entry.backup === "unsupported")
}

/** One line of a statement for a dialog: whitespace collapsed, cut at `max` characters. */
export function statementPreview(statement: string, max = STATEMENT_PREVIEW_CHARS): string {
  const line = statement.replace(/\s+/g, " ").trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** "3 rows moved to Trash" for a backed-up DELETE that removed rows, else null. */
export function trashedNote(result: Pick<ExecResult, "trashedRows">): string | null {
  const rows = result.trashedRows ?? 0
  return rows > 0 ? `${rowsLabel(rows)} moved to Trash` : null
}

/** Statement numbers as people count them (the backend's index plus one). */
export const statementNumber = (index: number) => index + 1

/** After the user declined to go on without a backup. */
export function stoppedMessage(statementIndex: number): string {
  const number = statementNumber(statementIndex)
  return number > 1
    ? `Stopped at statement ${number}: its rows couldn't be backed up. The statements before it ran.`
    : "Stopped at statement 1: its rows couldn't be backed up. Nothing ran."
}

/** A continued run (after "Delete without backup") failed. */
export function continueFailedMessage(statementIndex: number): string {
  return `The script couldn't continue from statement ${statementNumber(statementIndex)}`
}
