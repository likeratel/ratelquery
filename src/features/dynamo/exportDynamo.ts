import { save } from "@tauri-apps/plugin-dialog"
import { formatBytes } from "../../lib/cellFormat"
import type { ConnectionId } from "../../lib/connections"
import { dynamoApi, type DynamoExportOptions, type DynamoExportRequest } from "../../lib/dynamo"
import { isAppError } from "../../lib/ipc"
import { toast } from "../query/toastStore"

export type DynamoExportFormat = DynamoExportOptions["format"]

export const DYNAMO_EXPORT_FORMATS: readonly { format: DynamoExportFormat; label: string }[] = [
  { format: "json", label: "JSON" },
  { format: "jsonl", label: "JSON Lines" },
  { format: "csv", label: "CSV" },
]

interface DynamoExportInput {
  connectionId: ConnectionId
  table: string
  /** The request behind the current results; the backend follows every page of it. */
  request: DynamoExportRequest
  format: DynamoExportFormat
}

/** Asks for a path, exports every matching item through the backend and reports a toast. */
export async function exportDynamo({ connectionId, table, request, format }: DynamoExportInput) {
  let path: string | null
  try {
    path = await save({
      title: "Export items",
      defaultPath: `${table}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
  } catch {
    toast("The save dialog isn't available here", "danger")
    return
  }
  if (!path) return
  try {
    const written = await dynamoApi.export(connectionId, request, { format, path })
    const items = written.rows === 1 ? "item" : "items"
    toast(
      `Exported ${written.rows.toLocaleString()} ${items} · ${formatBytes(written.bytes)}`,
      "success",
    )
  } catch (raw) {
    toast(`Export failed: ${isAppError(raw) ? raw.message : "unknown error"}`, "danger")
  }
}
