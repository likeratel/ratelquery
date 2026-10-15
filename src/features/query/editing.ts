import { resolveEditTarget, type EditTargetResult } from "../../lib/gridEdits"
import type { QueryResult } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import { isSchemaLoading, type MysqlSession } from "../../state/sessionsStore"

/** The database the tab's next query runs against. */
export function tabDatabase(tab: QueryTab, session: MysqlSession | undefined): string | null {
  return tab.database ?? session?.currentDatabase ?? null
}

/**
 * Whether a result can be edited, judged against the database it was read from (recorded when
 * the run started), not the one currently picked in the status bar.
 */
export function editTargetFor(
  tab: QueryTab,
  result: QueryResult | undefined,
  session: MysqlSession | undefined,
): EditTargetResult {
  if (!result || result.kind !== "rows") return { editable: false, reason: "No rows" }
  const database = tab.ranDatabase
  const schema = database ? (session?.schemas[database] ?? null) : null
  if (database && !schema) {
    const reason = isSchemaLoading(session, database)
      ? "Loading the schema…"
      : "Schema not loaded. Use Refresh schema in the status bar."
    return { editable: false, reason }
  }
  return resolveEditTarget(result.columns, schema, database, result.statement)
}
