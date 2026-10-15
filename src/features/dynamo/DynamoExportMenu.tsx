import { ExportMenu } from "../../components/ui"
import type { DynamoExportRequest } from "../../lib/dynamo"
import { itemExportScopes } from "../../lib/exportScopes"
import { DYNAMO_EXPORT_FORMATS, exportDynamo } from "./exportDynamo"

interface DynamoExportMenuProps {
  connectionId: string
  table: string | null
  request: DynamoExportRequest | null
}

/** Exports every item matching the request behind the current results. */
export function DynamoExportMenu({ connectionId, table, request }: DynamoExportMenuProps) {
  return (
    <ExportMenu
      formats={DYNAMO_EXPORT_FORMATS}
      defaultFormat="json"
      scopesLabel="Items"
      scopes={request ? itemExportScopes(request) : []}
      disabled={!request || !table}
      disabledTitle="Run a scan or query first"
      onExport={(format) => {
        if (request && table) void exportDynamo({ connectionId, table, request, format })
      }}
    />
  )
}
