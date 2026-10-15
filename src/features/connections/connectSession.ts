import { showToast } from "../../components/ui/toastStore"
import {
  connectionsApi,
  type ConnectionId,
  type MysqlConnectionConfig,
  type SecretSlot,
} from "../../lib/connections"
import { normalizeError, type AppError } from "../../lib/ipc"
import type { MysqlSessionInfo } from "../../lib/mysql"
import { isPassphraseRequired } from "../../lib/ssh"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { describeError } from "./errors"
import { HOST_KEY_DECLINED, withHostKeyTrust } from "./hostKeyTrust"
import { requestPassword, type PasswordAnswer } from "./passwordPrompt"

/** Rejection of `connectMysql` when the user closes the password prompt. */
export const PASSWORD_CANCELLED: AppError = Object.freeze({
  kind: "credential",
  message: "No password was entered, so the connection wasn't opened.",
})

/**
 * True when a connect failed only because the user cancelled a prompt: the password prompt, or
 * the SSH host key prompt for a new key. Such a connect is the user's choice, not a failure.
 */
export function isPasswordCancelled(raw: unknown): boolean {
  return raw === PASSWORD_CANCELLED || raw === HOST_KEY_DECLINED
}

/** States in which the session needs no new connect (and so no password). */
const LIVE_STATES = new Set(["connected", "reconnecting", "connecting"])

/** Unknown keyring state counts as stored: the backend then reports its own error on connect. */
async function hasStoredSecret(id: ConnectionId, which: SecretSlot): Promise<boolean> {
  try {
    return await (which === "db"
      ? connectionsApi.hasSecret(id)
      : connectionsApi.hasSecret(id, which))
  } catch {
    return true
  }
}

/**
 * SSH auth that always needs a secret before connecting. A key file needs one only when it is
 * encrypted, which the backend reports on connect (see `withPassphrase`).
 */
function needsSshPassword(config: MysqlConnectionConfig): boolean {
  return config.ssh?.auth.type === "password"
}

/** Asks for one secret, or resolves with null when it is stored. Rejects when cancelled. */
async function askIfMissing(
  config: MysqlConnectionConfig,
  which: SecretSlot,
): Promise<PasswordAnswer | null> {
  if (await hasStoredSecret(config.id, which)) return null
  const answer = await requestPassword(config, which)
  if (!answer) throw PASSWORD_CANCELLED
  return answer
}

/**
 * Saves the remembered secrets with the connection in one request; on failure warns and returns
 * false. `null` leaves that secret as stored.
 */
async function rememberSecrets(
  config: MysqlConnectionConfig,
  secret: string | null,
  sshSecret: string | null,
): Promise<boolean> {
  if (secret === null && sshSecret === null) return false
  try {
    await (sshSecret === null
      ? connectionsApi.save(config, secret)
      : connectionsApi.save(config, secret, sshSecret))
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

/** Secrets to pass to this connect only; undefined ones come from the secret store. */
interface SessionSecrets {
  secret?: string
  sshSecret?: string
}

/**
 * Asks for the database password, then the SSH password, when the store holds none. Remembered
 * answers are saved; the rest (or all, when saving fails) are for this session only.
 */
async function collectSecrets(config: MysqlConnectionConfig): Promise<SessionSecrets> {
  const db = await askIfMissing(config, "db")
  const ssh = needsSshPassword(config) ? await askIfMissing(config, "ssh") : null
  const saved = await rememberSecrets(
    config,
    db?.remember ? db.secret : null,
    ssh?.remember ? ssh.secret : null,
  )
  const sessionOnly = (answer: PasswordAnswer | null) =>
    answer && !(saved && answer.remember) ? answer.secret : undefined
  return { secret: sessionOnly(db), sshSecret: sessionOnly(ssh) }
}

/**
 * Runs `attempt` with `sshSecret`; when the backend reports that the key file needs a
 * passphrase, asks for it and runs once more with it ("Remember" saves it first). Rejects with
 * `PASSWORD_CANCELLED` when the prompt is cancelled.
 */
async function withPassphrase<T>(
  config: MysqlConnectionConfig,
  sshSecret: string | undefined,
  attempt: (sshSecret: string | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(sshSecret)
  } catch (raw) {
    if (config.ssh?.auth.type !== "key" || !isPassphraseRequired(normalizeError(raw))) throw raw
    const answer = await requestPassword(config, "ssh")
    if (!answer) throw PASSWORD_CANCELLED
    const saved = answer.remember && (await rememberSecrets(config, null, answer.secret))
    return attempt(saved ? undefined : answer.secret)
  }
}

/**
 * Opens (or reuses) the MySQL session of a connection. When no secret is stored for it, the user
 * is asked for the password first, and for the SSH password next when the tunnel uses one. An
 * encrypted key file without a stored passphrase is asked for when the backend reports it.
 * "Remember" saves an answer, otherwise it is used for this session only. An unknown SSH host
 * key is shown for the user to trust, then the connect runs again. Rejects with
 * `PASSWORD_CANCELLED` or `HOST_KEY_DECLINED` when a prompt is cancelled, or with the connect
 * error.
 */
export async function connectMysql(connectionId: ConnectionId): Promise<MysqlSessionInfo> {
  const sessions = useSessionsStore.getState()
  const config = useConnectionsStore.getState().byId(connectionId)
  if (config?.kind !== "mysql") return sessions.connect(connectionId)
  const fallback = config.database ?? null
  const state = sessions.sessions[connectionId]?.state
  if (state && LIVE_STATES.has(state)) return sessions.connect(connectionId, fallback)
  const secrets = await collectSecrets(config)
  return withPassphrase(config, secrets.sshSecret, (sshSecret) =>
    withHostKeyTrust(config.ssh, () =>
      useSessionsStore.getState().connect(connectionId, fallback, secrets.secret, sshSecret),
    ),
  )
}
