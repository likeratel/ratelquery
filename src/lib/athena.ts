import type { AthenaConnectionConfig, ConnectionId } from "./connections"
import { ipc } from "./ipc"
import type { QueryResult, RowsResult, SchemaSnapshot } from "./mysql"

export interface AthenaQueryOptions {
  /** QueryExecutionContext.Database; absent runs without a default database. */
  database?: string
  /** QueryExecutionContext.Catalog; absent is "AwsDataCatalog". */
  catalog?: string
  /** Rows kept, default 1000 (same meaning as `mysql_query`). */
  maxRows?: number
}

export interface AthenaStats {
  executionId: string
  /** Statistics.DataScannedInBytes (0 for metadata statements). */
  dataScannedBytes: number
  /** Statistics.EngineExecutionTimeInMillis. */
  engineMs: number | null
  /** ResultConfiguration.OutputLocation of the execution. */
  outputLocation: string | null
}

/** A rows result plus Athena statistics. `reconnected` is always false. */
export interface AthenaRowsResult extends RowsResult {
  athena: AthenaStats
}

/** Narrows a query result to one that came from Athena. */
export function isAthenaResult(result: QueryResult): result is AthenaRowsResult {
  return result.kind === "rows" && "athena" in result
}

export const athenaApi = {
  /** Workgroup names, sorted. The secret fallback rule is that of `connections_test`. */
  workgroups: (config: AthenaConnectionConfig, secret: string | null) =>
    ipc<string[]>("athena_workgroups", { config, secret }),
  /**
   * Creates the default result bucket `connections_test` reported in `missingBucket`. Writes to
   * the user's AWS account: call it only after an explicit confirmation.
   */
  createOutputBucket: (config: AthenaConnectionConfig, secret: string | null, bucket: string) =>
    ipc<{ outputLocation: string }>("athena_create_output_bucket", { config, secret, bucket }),
  databases: (connectionId: ConnectionId) => ipc<string[]>("athena_databases", { connectionId }),
  schema: (connectionId: ConnectionId, database: string) =>
    ipc<SchemaSnapshot>("athena_schema", { connectionId, database }),
  /** Starts one statement; Athena rejects several in one call. */
  start: (connectionId: ConnectionId, sql: string, options: AthenaQueryOptions = {}) =>
    ipc<{ executionId: string }>("athena_start", { connectionId, sql, options }),
  /** Waits for the execution to finish and reads its rows. */
  wait: (connectionId: ConnectionId, executionId: string, maxRows?: number) =>
    ipc<AthenaRowsResult>(
      "athena_wait",
      maxRows === undefined
        ? { connectionId, executionId }
        : { connectionId, executionId, maxRows },
    ),
  cancel: (connectionId: ConnectionId, executionId: string) =>
    ipc<void>("athena_cancel", { connectionId, executionId }),
}
