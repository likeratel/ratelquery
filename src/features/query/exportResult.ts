import { save } from "@tauri-apps/plugin-dialog"
import { originTable } from "../../lib/gridEdits"
import { formatBytes } from "../../lib/cellFormat"
import type { ConnectionId } from "../../lib/connections"
import { isAppError } from "../../lib/ipc"
import { mysqlApi, type ExportFormat, type ExportOptions, type RowsResult } from "../../lib/mysql"
import { toast } from "./toastStore"

export type ExportScope = "visible" | "full"

export const EXPORT_FORMATS: readonly { format: ExportFormat; label: string }[] = [
  { format: "csv", label: "CSV" },
  { format: "json", label: "JSON" },
  { format: "sql", label: "SQL inserts" },
]

const DEFAULT_TABLE = "export"

/** Table name for INSERT statements: the single origin table when there is one. */
export function exportTableName(result: RowsResult): string {
  return originTable(result.columns, result.statement, null) ?? DEFAULT_TABLE
}

interface ExportRequest {
  connectionId: ConnectionId
  result: RowsResult
  format: ExportFormat
  scope: ExportScope
  /** Database the statement ran against; a full export re-runs it there. */
  database: string | null
}

/** Asks for a path, writes the file through the backend and reports the outcome as a toast. */
export async function exportResult({
  connectionId,
  result,
  format,
  scope,
  database,
}: ExportRequest) {
  const tableName = exportTableName(result)
  let path: string | null
  try {
    path = await save({
      title: "Export result",
      defaultPath: `${tableName}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
  } catch {
    toast("The save dialog isn't available here", "danger")
    return
  }
  if (!path) return
  const options: ExportOptions = {
    format,
    path,
    tableName,
    includeHeader: true,
    ...(database ? { database } : {}),
  }
  try {
    const written =
      scope === "full"
        ? await mysqlApi.export(connectionId, result.statement, options)
        : await mysqlApi.exportRows(result.columns, result.rows, options)
    const rows = written.rows === 1 ? "row" : "rows"
    toast(
      `Exported ${written.rows.toLocaleString()} ${rows} · ${formatBytes(written.bytes)}`,
      "success",
    )
  } catch (raw) {
    toast(`Export failed: ${isAppError(raw) ? raw.message : "unknown error"}`, "danger")
  }
}
