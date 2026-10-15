import type { DynamoExportRequest } from "./dynamo"

/** One "what to export" entry of an export menu. */
export interface ExportScopeOption<S extends string = string> {
  id: S
  label: string
  hint: string
  disabled?: boolean
  /** Explains why a disabled entry is off. */
  title?: string
}

/** Rows of a MySQL result: what is loaded, or the full result (single statement runs only). */
export function rowExportScopes(
  rowCount: number,
  allowFull: boolean,
): ExportScopeOption<"visible" | "full">[] {
  return [
    { id: "visible", label: "Visible rows", hint: `${rowCount.toLocaleString()} loaded` },
    {
      id: "full",
      label: "Full result",
      hint: allowFull ? "Re-runs without the row limit" : "Single statement only",
      disabled: !allowFull,
      title: allowFull ? undefined : "Run a single statement to export its full result",
    },
  ]
}

/** Items of a DynamoDB request: the backend follows every page of it. */
export function itemExportScopes(request: DynamoExportRequest): ExportScopeOption<"all">[] {
  const verb = "scan" in request ? "Scans" : "Queries"
  return [{ id: "all", label: "All matching items", hint: `${verb} every page, not just this one` }]
}
