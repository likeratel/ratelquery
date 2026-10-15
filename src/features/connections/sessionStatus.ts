import type { MysqlSession } from "../../state/sessionsStore"

export interface SessionStatus {
  state: "connected" | "connecting" | "reconnecting" | "error"
  /** Tooltip and accessible name. */
  label: string
}

const STATE_LABEL: Record<SessionStatus["state"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  error: "Connection error",
}

/**
 * What the sidebar dot shows for a MySQL session, or null when there is no live session.
 * The last error rides along in the label, also while connected (a failed schema load, say).
 */
export function sessionStatus(session: MysqlSession | undefined): SessionStatus | null {
  if (!session || session.state === "disconnected") return null
  const state = session.state
  const parts = [STATE_LABEL[state]]
  if (state === "connected" && session.serverVersion)
    parts[0] += ` · MySQL ${session.serverVersion}`
  if (session.lastError) parts.push(session.lastError.message)
  return { state, label: parts.join("\n") }
}

/**
 * Whether the dot should play its recovery ripple: the session recovered since the row first
 * saw it. Recoveries counted before the row mounted already played (or happened off screen).
 */
export function hasNewRecovery(session: MysqlSession | undefined, seenReconnects: number): boolean {
  return (session?.reconnects ?? 0) > seenReconnects
}
