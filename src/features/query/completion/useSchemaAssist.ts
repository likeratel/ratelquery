import type { CompletionSource } from "@codemirror/autocomplete"
import type { Extension } from "@codemirror/state"
import { useEffect, useState } from "react"
import type { ConnectionId } from "../../../lib/connections"
import type { QueryEngine } from "../../../lib/queryTabs"
import { createAthenaCompletionEnv } from "./athenaEnv"
import { createSessionCompletionEnv } from "./sessionEnv"

/** Schema-aware editor features: completion sources and the hover tooltip. */
export interface SchemaAssist {
  completionSources: readonly CompletionSource[]
  hover: Extension
}

/**
 * Completion sources and schema hover for an editor on `connectionId` running in `database`;
 * `engine` picks the catalog (the MySQL session or the Athena catalog store). Both import
 * CodeMirror, so they load with the editor chunk instead of the main bundle; until then (or if
 * that chunk fails to load) the editor keeps lang-sql's keyword completion and has no hover.
 */
export function useSchemaAssist(
  connectionId: ConnectionId,
  database: string | null,
  engine: QueryEngine = "mysql",
): SchemaAssist | undefined {
  const [assist, setAssist] = useState<SchemaAssist | undefined>(undefined)
  useEffect(() => {
    let current = true
    Promise.all([import("./source"), import("./hover")])
      .then(([{ sqlCompletionSources }, { schemaHover }]) => {
        if (!current) return
        const env =
          engine === "athena"
            ? createAthenaCompletionEnv(connectionId, database)
            : createSessionCompletionEnv(connectionId, database)
        setAssist({ completionSources: sqlCompletionSources(env), hover: schemaHover(env) })
      })
      .catch(() => {
        /* The chunk failed to load: the editor keeps keyword completion. */
      })
    return () => {
      current = false
    }
  }, [connectionId, database, engine])
  return assist
}
