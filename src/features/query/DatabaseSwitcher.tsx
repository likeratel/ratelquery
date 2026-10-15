import { RefreshCw } from "lucide-react"
import { showToast } from "../../components/ui"
import type { QueryTab } from "../../lib/queryTabs"
import { isSchemaLoading, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"

/** Database picker and schema refresh for a query tab, shown in the editor bar. */
export function DatabaseSwitcher({ tab }: { tab: QueryTab }) {
  const setDatabase = useTabsStore((s) => s.setDatabase)
  const session = useSessionsStore((s) => s.sessions[tab.connectionId])
  const loadDatabases = useSessionsStore((s) => s.loadDatabases)
  const refreshSchema = useSessionsStore((s) => s.refreshSchema)

  const database = tab.database ?? session?.currentDatabase ?? null
  const databases = session?.databases ?? []
  const options = database && !databases.includes(database) ? [database, ...databases] : databases
  const schemaLoading = isSchemaLoading(session, database)

  const changeDatabase = (next: string | null) => {
    if (!setDatabase(tab.id, next)) {
      showToast({
        tone: "info",
        message: "Apply or discard pending changes before switching databases",
      })
    }
  }

  return (
    <div className="db-switch">
      <label className="db-switch__field">
        <span className="db-switch__label">Database</span>
        <select
          className="db-switch__select"
          value={database ?? ""}
          onFocus={() => {
            if (databases.length === 0) void loadDatabases(tab.connectionId)
          }}
          onChange={(event) => changeDatabase(event.target.value || null)}
        >
          <option value="">None</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {database && (
        <button
          type="button"
          className="ui-icon-button"
          data-size="md"
          disabled={schemaLoading}
          onClick={() => void refreshSchema(tab.connectionId, database)}
          aria-label={schemaLoading ? "Loading schema" : "Refresh schema"}
          title="Reload tables and columns for completion and editing"
        >
          <RefreshCw size={13} strokeWidth={2} className={schemaLoading ? "spin" : undefined} />
        </button>
      )}
    </div>
  )
}
