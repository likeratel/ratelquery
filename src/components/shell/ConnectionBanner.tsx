import type { CSSProperties } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  CONNECTION_KIND_ICON,
  CONNECTION_KIND_LABEL,
  connectionSubtitle,
} from "../../features/connections"
import { athenaTabDatabase, tabDatabase } from "../../features/query"
import type { TabsState } from "../../lib/queryTabs"
import { useAthenaStore } from "../../state/athenaStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"

/** The active tab's fields the banner reads; a new SQL keystroke doesn't change them. */
function selectBannerTab(state: TabsState) {
  const tab = selectActiveTab(state)
  if (!tab) return null
  return {
    kind: tab.kind,
    connectionId: tab.connectionId,
    engine: tab.kind === "query" ? tab.engine : null,
    database: tab.kind === "dynamo" ? null : tab.database,
  }
}

/** The database the active tab works in, when it has one (DynamoDB tabs don't). */
function useActiveDatabase(tab: ReturnType<typeof selectBannerTab>): string | null {
  const mysql = useSessionsStore((s) =>
    tab?.engine === "mysql" ? tabDatabase(tab, s.sessions[tab.connectionId]) : null,
  )
  const athena = useAthenaStore((s) =>
    tab?.engine === "athena" ? athenaTabDatabase(tab, s.catalogs[tab.connectionId]) : null,
  )
  if (tab?.kind === "table") return tab.database
  return mysql ?? athena
}

/**
 * Full-width strip above every tab's screen naming the server it talks to: the connection
 * colour as a band, its kind, name and target, and the database in use. Shown so a statement is
 * never run against the wrong server by mistake.
 */
export function ConnectionBanner() {
  const tab = useTabsStore(useShallow(selectBannerTab))
  const connectionId = tab?.connectionId ?? null
  const config = useConnectionsStore((s) => s.connections.find((c) => c.id === connectionId))
  const active = useActiveDatabase(tab)
  // Before the session connects, a MySQL run uses the connection's default database.
  const fallback = !active && config?.kind === "mysql" ? (config.database ?? null) : null
  const database = active ?? fallback
  if (!connectionId) return null
  const KindIcon = config ? CONNECTION_KIND_ICON[config.kind] : null
  const style = config?.color ? ({ "--conn": config.color } as CSSProperties) : undefined

  return (
    <div className="conn-banner" role="status" aria-label="Active connection" style={style}>
      {KindIcon && config && (
        <KindIcon
          size={13}
          strokeWidth={2}
          className="conn-banner__kind"
          aria-label={CONNECTION_KIND_LABEL[config.kind]}
        />
      )}
      <span className="conn-banner__name">{config?.name ?? "Unknown connection"}</span>
      {config && <span className="conn-banner__target">{connectionSubtitle(config)}</span>}
      {database && (
        <span className="conn-banner__database">
          <span className="conn-banner__label">{fallback ? "Default database" : "Database"}</span>
          {database}
        </span>
      )}
    </div>
  )
}
