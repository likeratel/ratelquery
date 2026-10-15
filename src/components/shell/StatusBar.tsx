import { useEffect, useRef, useState } from "react"
import { formatElapsed } from "../../lib/cellFormat"
import { isTauri } from "@tauri-apps/api/core"
import { DynamoStatus } from "../../features/dynamo"
import type { MysqlTlsMode } from "../../lib/connections"
import { ipc } from "../../lib/ipc"
import { useConnectionsStore } from "../../state/connectionsStore"
import { isSchemaLoading, useSessionsStore, type MysqlSession } from "../../state/sessionsStore"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"
import { showToast } from "../ui"

interface AppInfo {
  name: string
  version: string
}

const STATE_LABELS: Record<MysqlSession["state"], string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  error: "Connection error",
}

const TLS_LABELS: Record<MysqlTlsMode, string> = {
  preferred: "TLS preferred",
  required: "TLS required",
  verify_ca: "TLS verify CA",
  verify_identity: "TLS verify identity",
}

/** Replays the ripple once each time `reconnects` grows for the same connection. */
function useReconnectRipple(connectionId: string | null, reconnects: number): number {
  const [ripple, setRipple] = useState(0)
  const previous = useRef({ connectionId, reconnects })
  useEffect(() => {
    const last = previous.current
    if (last.connectionId === connectionId && reconnects > last.reconnects) {
      setRipple((n) => n + 1)
    }
    previous.current = { connectionId, reconnects }
  }, [connectionId, reconnects])
  return ripple
}

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    ipc<AppInfo>("app_info")
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch((error: unknown) => {
        console.error("app_info failed", error)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return info
}

export function StatusBar() {
  const info = useAppInfo()
  const active = useTabsStore(selectActiveTab)
  const tab = active?.kind === "query" ? active : null
  const setDatabase = useTabsStore((s) => s.setDatabase)
  const session = useSessionsStore((s) => (tab ? s.sessions[tab.connectionId] : undefined))
  const loadDatabases = useSessionsStore((s) => s.loadDatabases)
  const refreshSchema = useSessionsStore((s) => s.refreshSchema)
  const connection = useConnectionsStore((s) =>
    tab ? s.connections.find((c) => c.id === tab.connectionId) : undefined,
  )
  const ripple = useReconnectRipple(tab?.connectionId ?? null, session?.reconnects ?? 0)

  const state = session?.state ?? "disconnected"
  const database = tab ? (tab.database ?? session?.currentDatabase ?? null) : null
  const databases = session?.databases ?? []
  const options = database && !databases.includes(database) ? [database, ...databases] : databases
  const schemaLoading = isSchemaLoading(session, database)
  const tls = connection?.kind === "mysql" ? (connection.tls ?? "preferred") : null

  const changeDatabase = (tabId: string, next: string | null) => {
    if (!setDatabase(tabId, next)) {
      showToast({
        tone: "info",
        message: "Apply or discard pending changes before switching databases",
      })
    }
  }

  return (
    <footer className="statusbar">
      {active?.kind === "dynamo" ? (
        <DynamoStatus tab={active} />
      ) : tab ? (
        <>
          <span
            className="statusbar__item"
            title={session?.lastError?.message ?? STATE_LABELS[state]}
          >
            <span className="dot" data-state={state}>
              {ripple > 0 && <span key={ripple} className="dot__ripple" />}
            </span>
            {connection?.name ?? "Unknown connection"}
          </span>
          {session?.serverVersion && (
            <span className="statusbar__item">MySQL {session.serverVersion}</span>
          )}
          {tls && <span className="statusbar__item">{TLS_LABELS[tls]}</span>}
          <label className="statusbar__item statusbar__db">
            <span className="statusbar__label">Database</span>
            <select
              className="statusbar__select"
              value={database ?? ""}
              onFocus={() => {
                if (databases.length === 0) void loadDatabases(tab.connectionId)
              }}
              onChange={(event) => changeDatabase(tab.id, event.target.value || null)}
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
              className="statusbar__link"
              disabled={schemaLoading}
              onClick={() => void refreshSchema(tab.connectionId, database)}
              title="Reload tables and columns for completion and editing"
            >
              {schemaLoading ? "Loading schema…" : "Refresh schema"}
            </button>
          )}
          {tab.lastElapsedMs !== null && (
            <span className="statusbar__item">Last query {formatElapsed(tab.lastElapsedMs)}</span>
          )}
        </>
      ) : (
        <span className="statusbar__item">
          <span className="dot" data-state="idle" />
          Not connected
        </span>
      )}
      <span className="statusbar__spacer" />
      {info && <span className="statusbar__item">v{info.version}</span>}
    </footer>
  )
}
