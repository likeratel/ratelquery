import { ExportMenu } from "../../components/ui"
import { rowExportScopes } from "../../lib/exportScopes"
import type { RowsResult } from "../../lib/mysql"
import { EXPORT_FORMATS, exportResult } from "./exportResult"

interface ResultExportMenuProps {
  connectionId: string
  result: RowsResult
  /** Full export re-runs the statement, so it is only offered for single-statement runs. */
  allowFull: boolean
  database: string | null
}

export function ResultExportMenu({
  connectionId,
  result,
  allowFull,
  database,
}: ResultExportMenuProps) {
  return (
    <ExportMenu
      formats={EXPORT_FORMATS}
      defaultFormat="csv"
      scopesLabel="Rows"
      scopes={rowExportScopes(result.rowCount, allowFull)}
      onExport={(format, scope) =>
        void exportResult({ connectionId, result, format, scope, database })
      }
    />
  )
}
