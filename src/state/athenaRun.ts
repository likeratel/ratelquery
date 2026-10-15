import { athenaApi, type AthenaQueryOptions, type AthenaRowsResult } from "../lib/athena"
import type { ConnectionId } from "../lib/connections"
import type { AppError } from "../lib/ipc"

/** Rejection of a run the user stopped before its next statement started. */
export const ATHENA_RUN_CANCELLED: AppError = Object.freeze({
  kind: "query",
  message: "The query was cancelled",
})

export interface AthenaRunHooks {
  /** Called with the execution id once a statement started, and with null once it finished. */
  onExecution: (executionId: string | null) => void
  /** True once the user asked to stop the run. */
  cancelled: () => boolean
}

/**
 * Runs `statements` one after another, each as its own query execution, and resolves with one
 * result per statement. Nothing is retried: every execution is billed. A failed statement
 * rejects and the rest never start. A cancel that arrives while a statement is being started
 * stops that execution as soon as its id is known.
 */
export async function runAthenaStatements(
  connectionId: ConnectionId,
  statements: readonly string[],
  options: AthenaQueryOptions,
  hooks: AthenaRunHooks,
): Promise<AthenaRowsResult[]> {
  const results: AthenaRowsResult[] = []
  for (const sql of statements) {
    if (hooks.cancelled()) throw ATHENA_RUN_CANCELLED
    const { executionId } = await athenaApi.start(connectionId, sql, options)
    hooks.onExecution(executionId)
    try {
      if (hooks.cancelled()) {
        await athenaApi.cancel(connectionId, executionId)
        throw ATHENA_RUN_CANCELLED
      }
      results.push(await athenaApi.wait(connectionId, executionId, options.maxRows))
    } finally {
      hooks.onExecution(null)
    }
  }
  return results
}
