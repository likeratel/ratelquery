import { showToast } from "../../components/ui/toastStore"
import {
  connectionsApi,
  type ConnectionId,
  type MysqlConnectionConfig,
} from "../../lib/connections"
import { normalizeError, type AppError } from "../../lib/ipc"
import type { MysqlSessionInfo } from "../../lib/mysql"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { describeError } from "./errors"
import { requestPassword } from "./passwordPrompt"

/** Rejection of `connectMysql` when the user closes the password prompt. */
export const PASSWORD_CANCELLED: AppError = Object.freeze({
  kind: "credential",
  message: "No password was entered, so the connection wasn't opened.",
})

/** True when a connect failed only because the user cancelled the password prompt. */
export function isPasswordCancelled(raw: unknown): boolean {
  return raw === PASSWORD_CANCELLED
}

/** States in which the session needs no new connect (and so no password). */
const LIVE_STATES = new Set(["connected", "reconnecting", "connecting"])

/** Unknown keyring state counts as stored: the backend then reports its own error on connect. */
async function hasStoredSecret(id: ConnectionId): Promise<boolean> {
  try {
    return await connectionsApi.hasSecret(id)
  } catch {
    return true
  }
}

/** Saves the secret with the connection; on failure warns and returns false. */
async function rememberSecret(config: MysqlConnectionConfig, secret: string): Promise<boolean> {
  try {
    await connectionsApi.save(config, secret)
    return true
  } catch (raw) {
    const error = describeError(normalizeError(raw), "save")
    showToast({
      tone: "warning",
      message: "Couldn't save the password; it is used for this session only.",
      detail: error.detail,
    })
    return false
  }
}

/**
 * Opens (or reuses) the MySQL session of a connection. When no secret is stored for it, the user
 * is asked for the password first; "Remember password" saves it, otherwise it is used for this
 * session only. Rejects with `PASSWORD_CANCELLED` when the prompt is cancelled, or with the
 * connect error.
 */
export async function connectMysql(connectionId: ConnectionId): Promise<MysqlSessionInfo> {
  const sessions = useSessionsStore.getState()
  const config = useConnectionsStore.getState().byId(connectionId)
  if (config?.kind !== "mysql") return sessions.connect(connectionId)
  const fallback = config.database ?? null
  const state = sessions.sessions[connectionId]?.state
  if ((state && LIVE_STATES.has(state)) || (await hasStoredSecret(connectionId))) {
    return sessions.connect(connectionId, fallback)
  }
  const answer = await requestPassword(config)
  if (!answer) throw PASSWORD_CANCELLED
  const connect = useSessionsStore.getState().connect
  if (answer.remember && (await rememberSecret(config, answer.secret))) {
    return connect(connectionId, fallback)
  }
  return connect(connectionId, fallback, answer.secret)
}
