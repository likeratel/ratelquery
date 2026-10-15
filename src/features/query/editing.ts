import { resolveEditTarget, type EditTargetResult } from "../../lib/gridEdits"
import type { QueryResult } from "../../lib/mysql"
import type { QueryTab } from "../../lib/queryTabs"
import type { MysqlSession } from "../../state/sessionsStore"

/** The database a tab's queries ran against. */
export function tabDatabase(tab: QueryTab, session: MysqlSession | undefined): string | null {
  return tab.database ?? session?.currentDatabase ?? null
}

export function editTargetFor(
  tab: QueryTab,
  result: QueryResult | undefined,
  session: MysqlSession | undefined,
): EditTargetResult {
  if (!result || result.kind !== "rows") return { editable: false, reason: "No rows" }
  const database = tabDatabase(tab, session)
  const schema = database ? (session?.schemas[database] ?? null) : null
  if (database && !schema) {
    const reason = session?.schemaLoading
      ? "Loading the schema…"
      : "Schema not loaded. Use Refresh schema in the status bar."
    return { editable: false, reason }
  }
  return resolveEditTarget(result.columns, schema, database, result.statement)
}
