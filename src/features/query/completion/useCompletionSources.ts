import type { CompletionSource } from "@codemirror/autocomplete"
import { useEffect, useState } from "react"
import type { ConnectionId } from "../../../lib/connections"
import type { QueryEngine } from "../../../lib/queryTabs"
import { createAthenaCompletionEnv } from "./athenaEnv"
import { createSessionCompletionEnv } from "./sessionEnv"

/**
 * Completion sources for an editor on `connectionId` running in `database`; `engine` picks the
 * catalog (the MySQL session or the Athena catalog store). The sources import
 * CodeMirror, so they load with the editor chunk instead of the main bundle; until then (or if
 * that chunk fails to load) the editor keeps lang-sql's keyword completion.
 */
export function useCompletionSources(
  connectionId: ConnectionId,
  database: string | null,
  engine: QueryEngine = "mysql",
): readonly CompletionSource[] | undefined {
  const [sources, setSources] = useState<readonly CompletionSource[] | undefined>(undefined)
  useEffect(() => {
    let current = true
    import("./source")
      .then(({ sqlCompletionSources }) => {
        if (!current) return
        const env =
          engine === "athena"
            ? createAthenaCompletionEnv(connectionId, database)
            : createSessionCompletionEnv(connectionId, database)
        setSources(sqlCompletionSources(env))
      })
      .catch(() => {
        /* The chunk failed to load: the editor keeps keyword completion. */
      })
    return () => {
      current = false
    }
  }, [connectionId, database, engine])
  return sources
}
