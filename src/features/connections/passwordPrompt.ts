import { create } from "zustand"
import type { ConnectionConfig, ConnectionId, SecretSlot } from "../../lib/connections"

/** What the user chose in the password prompt. */
export interface PasswordAnswer {
  secret: string
  /** Save the secret with the connection instead of using it for this session only. */
  remember: boolean
}

export interface PasswordRequest {
  /** Unique per request, so the dialog starts empty for each one. */
  id: number
  config: ConnectionConfig
  /** The database password, or the SSH password / key passphrase of the tunnel. */
  which: SecretSlot
}

interface PasswordPromptState {
  /** Waiting requests, oldest first; the dialog shows the first one. */
  queue: readonly PasswordRequest[]
  /** Settles the request with the answer, or null when the user cancelled. */
  answer: (requestId: number, answer: PasswordAnswer | null) => void
}

interface Pending {
  connectionId: ConnectionId
  which: SecretSlot
  promise: Promise<PasswordAnswer | null>
  resolve: (answer: PasswordAnswer | null) => void
}

let nextRequestId = 0
const pending = new Map<number, Pending>()

export const usePasswordPrompt = create<PasswordPromptState>((set) => ({
  queue: [],
  answer: (requestId, answer) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    set((state) => ({ queue: state.queue.filter((r) => r.id !== requestId) }))
    entry?.resolve(answer)
  },
}))

/**
 * Asks for the password of `config` (`which` picks the database or the SSH secret). Resolves
 * with the answer, or null when the user cancels. Callers asking for the same secret of the same
 * connection while a prompt is open share it.
 */
export function requestPassword(
  config: ConnectionConfig,
  which: SecretSlot = "db",
): Promise<PasswordAnswer | null> {
  for (const entry of pending.values()) {
    if (entry.connectionId === config.id && entry.which === which) return entry.promise
  }
  const id = ++nextRequestId
  let resolve: (answer: PasswordAnswer | null) => void = () => {}
  const promise = new Promise<PasswordAnswer | null>((r) => (resolve = r))
  pending.set(id, { connectionId: config.id, which, promise, resolve })
  usePasswordPrompt.setState((state) => ({ queue: [...state.queue, { id, config, which }] }))
  return promise
}

/** Copy of the password prompt for one request. */
export interface PromptCopy {
  title: string
  /** Shown under the title in monospace: where the secret is used. */
  subtitle: string
  fieldLabel: string
  rememberLabel: string
  /** Label of the button that connects with an empty secret, or null when that makes no sense. */
  skipLabel: string | null
}

/** Picks the prompt copy for the database password, an SSH password or a key passphrase. */
export function promptCopy(request: Pick<PasswordRequest, "config" | "which">): PromptCopy {
  const { config, which } = request
  const ssh = config.kind === "mysql" && which === "ssh" ? config.ssh : undefined
  if (ssh?.auth.type === "key") {
    return {
      title: `Key passphrase for ${ssh.user}@${ssh.host}`,
      subtitle: ssh.auth.keyPath,
      fieldLabel: "Passphrase",
      rememberLabel: "Remember passphrase",
      skipLabel: "Connect without a passphrase",
    }
  }
  if (ssh) {
    return {
      title: `SSH password for ${ssh.user}@${ssh.host}`,
      subtitle: `${ssh.user}@${ssh.host}:${ssh.port}`,
      fieldLabel: "SSH password",
      rememberLabel: "Remember password",
      skipLabel: null,
    }
  }
  return {
    title: `Password for ${config.name}`,
    subtitle: config.kind === "mysql" ? `${config.user}@${config.host}:${config.port}` : "",
    fieldLabel: "Password",
    rememberLabel: "Remember password",
    skipLabel: "Connect without a password",
  }
}

/** Test seam: cancels every open request and empties the queue. */
export function resetPasswordPrompt(): void {
  const entries = [...pending.values()]
  pending.clear()
  usePasswordPrompt.setState({ queue: [] })
  for (const entry of entries) entry.resolve(null)
}
