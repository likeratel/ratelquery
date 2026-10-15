import { CircleAlert, RefreshCw } from "lucide-react"
import { showToast } from "../../components/ui"
import { isAthenaSchemaLoading } from "../../lib/athenaCatalog"
import { errorLine } from "../../lib/errorHints"
import type { QueryTab } from "../../lib/queryTabs"
import { useAthenaStore } from "../../state/athenaStore"
import { isSchemaLoading, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { athenaTabDatabase } from "./editing"

interface SwitcherViewProps {
  database: string | null
  databases: readonly string[]
  schemaLoading: boolean
  refreshTitle: string
  onOpen: () => void
  onChange: (database: string | null) => void
  onRefresh: (database: string) => void
  /** Why the last database or schema load failed; shown with a retry button. */
  error?: string | null
  onRetry?: () => void
}

/** The select and refresh button; the stores behind them differ per engine. */
function SwitcherView(props: SwitcherViewProps) {
  const { database, databases, schemaLoading, error, onRetry } = props
  const options = database && !databases.includes(database) ? [database, ...databases] : databases
  return (
    <div className="db-switch">
      {error && onRetry && (
        <button
          type="button"
          className="ui-icon-button db-switch__error"
          data-size="md"
          onClick={onRetry}
          aria-label={`Couldn't load the catalog: ${error}. Try again`}
          title={`${error}\nClick to try again.`}
        >
          <CircleAlert size={13} strokeWidth={2} />
        </button>
      )}
      <label className="db-switch__field">
        <span className="db-switch__label">Database</span>
        <select
          className="db-switch__select"
          value={database ?? ""}
          title={error ?? undefined}
          onFocus={props.onOpen}
          onChange={(event) => props.onChange(event.target.value || null)}
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
          onClick={() => props.onRefresh(database)}
          aria-label={schemaLoading ? "Loading schema" : "Refresh schema"}
          title={props.refreshTitle}
        >
          <RefreshCw size={13} strokeWidth={2} className={schemaLoading ? "spin" : undefined} />
        </button>
      )}
    </div>
  )
}

function useChangeDatabase(tabId: string) {
  const setDatabase = useTabsStore((s) => s.setDatabase)
  return (next: string | null) => {
    if (!setDatabase(tabId, next)) {
      showToast({
        tone: "info",
        message: "Apply or discard pending changes before switching databases",
      })
    }
  }
}

function MysqlDatabaseSwitcher({ tab }: { tab: QueryTab }) {
  const session = useSessionsStore((s) => s.sessions[tab.connectionId])
  const loadDatabases = useSessionsStore((s) => s.loadDatabases)
  const refreshSchema = useSessionsStore((s) => s.refreshSchema)
  const changeDatabase = useChangeDatabase(tab.id)
  const database = tab.database ?? session?.currentDatabase ?? null
  const databases = session?.databases ?? []
  return (
    <SwitcherView
      database={database}
      databases={databases}
      schemaLoading={isSchemaLoading(session, database)}
      refreshTitle="Reload tables and columns for completion and editing"
      onOpen={() => {
        if (databases.length === 0) void loadDatabases(tab.connectionId)
      }}
      onChange={changeDatabase}
      onRefresh={(name) => void refreshSchema(tab.connectionId, name)}
    />
  )
}

function AthenaDatabaseSwitcher({ tab }: { tab: QueryTab }) {
  const catalog = useAthenaStore((s) => s.catalogs[tab.connectionId])
  const changeDatabase = useChangeDatabase(tab.id)
  const database = athenaTabDatabase(tab, catalog)
  const { loadDatabases, refreshSchema } = useAthenaStore.getState()
  const error = catalog?.lastError && !catalog.loading ? errorLine(catalog.lastError) : null
  return (
    <SwitcherView
      database={database}
      databases={catalog?.databases ?? []}
      schemaLoading={isAthenaSchemaLoading(catalog, database)}
      refreshTitle="Reload tables and columns for completion"
      onOpen={() => {
        // A failed list is retried when the picker opens again.
        if (!catalog?.databases) void loadDatabases(tab.connectionId)
      }}
      onChange={changeDatabase}
      onRefresh={(name) => void refreshSchema(tab.connectionId, name)}
      error={error}
      onRetry={() => {
        // The error may come from the list or from a schema: listing again clears it.
        void loadDatabases(tab.connectionId, true)
        if (database) void refreshSchema(tab.connectionId, database)
      }}
    />
  )
}

/** Database picker and schema refresh for a query tab, shown in the editor bar. */
export function DatabaseSwitcher({ tab }: { tab: QueryTab }) {
  return tab.engine === "athena" ? (
    <AthenaDatabaseSwitcher tab={tab} />
  ) : (
    <MysqlDatabaseSwitcher tab={tab} />
  )
}
