import { CircleAlert, RefreshCw, Rows3 } from "lucide-react"
import { useEffect } from "react"
import { Button } from "../../components/ui"
import type { TableTab } from "../../lib/queryTabs"
import { selectActiveTableTab, useTabsStore } from "../../state/tabsStore"
import { loadTableDetails, selectRows } from "./actions"
import { tableFacts } from "./details"
import { TableSections } from "./TableSections"
import "./schema.css"

function Header({ tab }: { tab: TableTab }) {
  const { details } = tab
  return (
    <header className="table-ws__header">
      <div className="table-ws__titles">
        <h1 className="table-ws__title mono" title={`${tab.database}.${tab.table}`}>
          <span className="table-ws__faint">{tab.database}.</span>
          {tab.table}
        </h1>
        {details && (
          <dl className="table-ws__facts">
            {tableFacts(details).map((fact) => (
              <div key={fact.label} className="table-ws__fact" title={fact.title}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {details?.comment && <p className="table-ws__comment">{details.comment}</p>}
      </div>
      <div className="table-ws__toolbar">
        <Button
          size="sm"
          onClick={() => void selectRows(tab.connectionId, tab.database, tab.table)}
        >
          <Rows3 size={13} aria-hidden />
          Select rows
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void loadTableDetails(tab.id, true)}
          disabled={tab.loading}
        >
          <RefreshCw size={13} aria-hidden className={tab.loading ? "tree-spin" : undefined} />
          Refresh
        </Button>
      </div>
    </header>
  )
}

/** The active table tab: summary, columns, indexes, foreign keys and DDL. */
export function TableWorkspace() {
  const tab = useTabsStore(selectActiveTableTab)
  const tabId = tab?.id

  useEffect(() => {
    // Loads once per tab; later visits reuse the cached details until Refresh.
    if (tabId) void loadTableDetails(tabId)
  }, [tabId])

  if (!tab) return null
  return (
    <div className="table-ws" key={tab.id}>
      <Header tab={tab} />
      <div className="table-ws__body">
        {tab.error && (
          <div className="table-ws__error" role="alert">
            <CircleAlert size={14} aria-hidden />
            <span>
              {tab.error.kind === "not_found"
                ? `${tab.database}.${tab.table} no longer exists.`
                : tab.error.message}
            </span>
          </div>
        )}
        {!tab.details && tab.loading && <p className="table-ws__none">Loading table details…</p>}
        {tab.details && <TableSections details={tab.details} />}
      </div>
    </div>
  )
}
