import type { SshConfig } from "../../lib/connections"
import { normalizeError, type AppError } from "../../lib/ipc"
import { canTrustHostKey, parseHostKeyMessage, sshApi } from "../../lib/ssh"
import { requestHostKeyTrust } from "./hostKeyPrompt"

/** Rejection when the user didn't trust a new SSH host key, so nothing was opened. */
export const HOST_KEY_DECLINED: AppError = Object.freeze({
  kind: "ssh_host_key",
  message: "The SSH host key wasn't trusted, so the connection wasn't opened.",
})

/** Trust decisions in flight per SSH server, so concurrent connects ask and save once. */
const inflight = new Map<string, Promise<void>>()

/**
 * Asks the user about the host key in `error` and saves it when trusted. Rejects with
 * `HOST_KEY_DECLINED` when a new key is declined, with `error` itself when the key can't be
 * trusted from the app (changed, or the message carries no known_hosts line), or with the
 * `ssh_trust_host` failure.
 */
function confirmHostKey(ssh: SshConfig, error: AppError): Promise<void> {
  const key = `${ssh.host.toLowerCase()}:${ssh.port}`
  const existing = inflight.get(key)
  if (existing) return existing
  const request = (async () => {
    const details = parseHostKeyMessage(error.message)
    const trusted = await requestHostKeyTrust({ host: ssh.host, port: ssh.port }, error.message)
    if (!canTrustHostKey(details)) throw error
    if (!trusted) throw HOST_KEY_DECLINED
    await sshApi.trustHost(ssh.host, ssh.port, details.keyLine)
  })().finally(() => {
    if (inflight.get(key) === request) inflight.delete(key)
  })
  inflight.set(key, request)
  return request
}

/**
 * Runs `attempt`; when it fails with `ssh_host_key` for a connection that goes through `ssh`,
 * asks the user to trust the key and, once trusted and saved, runs it again. Retries once: a
 * second host key error is returned as is. Other failures pass through unchanged.
 */
export async function withHostKeyTrust<T>(
  ssh: SshConfig | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt()
  } catch (raw) {
    const error = normalizeError(raw)
    if (!ssh || error.kind !== "ssh_host_key") throw raw
    await confirmHostKey(ssh, error)
    return attempt()
  }
}
