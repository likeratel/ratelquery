import { isAthenaResult } from "../../lib/athena"
import type { AthenaCatalog } from "../../lib/athenaCatalog"
import { resolveEditTarget, type EditTargetResult } from "../../lib/gridEdits"
import type { QueryResult } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import { isSchemaLoading, type MysqlSession } from "../../state/sessionsStore"

/** The database the tab's next query runs against. */
export function tabDatabase(tab: QueryTab, session: MysqlSession | undefined): string | null {
  return tab.database ?? session?.currentDatabase ?? null
}

export const ATHENA_READ_ONLY = "Athena results are read only"

/** The database an Athena tab's next statement runs in. */
export function athenaTabDatabase(
  tab: Pick<QueryTab, "database">,
  catalog: AthenaCatalog | undefined,
): string | null {
  return tab.database ?? catalog?.currentDatabase ?? null
}

/**
 * Whether a result can be edited, judged against the database it was read from (recorded when
 * the run started), not the one currently picked next to the Run button. Athena results never
 * are: there is no row-level write path, and a re-run would be billed.
 */
export function editTargetFor(
  tab: Pick<QueryTab, "ranDatabase"> & Partial<Pick<QueryTab, "engine">>,
  result: QueryResult | undefined,
  session: MysqlSession | undefined,
): EditTargetResult {
  if (tab.engine === "athena" || (result && isAthenaResult(result))) {
    return { editable: false, reason: ATHENA_READ_ONLY }
  }
  if (!result || result.kind !== "rows") return { editable: false, reason: "No rows" }
  const database = tab.ranDatabase
  const schema = database ? (session?.schemas[database] ?? null) : null
  if (database && !schema) {
    const reason = isSchemaLoading(session, database)
      ? "Loading the schema…"
      : "Schema not loaded. Use Refresh schema next to the Run button."
    return { editable: false, reason }
  }
  return resolveEditTarget(result.columns, schema, database, result.statement)
}
