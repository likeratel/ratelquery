import { create } from "zustand"
import type { ConnectionConfig, ConnectionId } from "../../lib/connections"

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
}

interface PasswordPromptState {
  /** Waiting requests, oldest first; the dialog shows the first one. */
  queue: readonly PasswordRequest[]
  /** Settles the request with the answer, or null when the user cancelled. */
  answer: (requestId: number, answer: PasswordAnswer | null) => void
}

interface Pending {
  connectionId: ConnectionId
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
 * Asks for the password of `config`. Resolves with the answer, or null when the user cancels.
 * Callers asking for the same connection while a prompt is open share it.
 */
export function requestPassword(config: ConnectionConfig): Promise<PasswordAnswer | null> {
  for (const entry of pending.values()) {
    if (entry.connectionId === config.id) return entry.promise
  }
  const id = ++nextRequestId
  let resolve: (answer: PasswordAnswer | null) => void = () => {}
  const promise = new Promise<PasswordAnswer | null>((r) => (resolve = r))
  pending.set(id, { connectionId: config.id, promise, resolve })
  usePasswordPrompt.setState((state) => ({ queue: [...state.queue, { id, config }] }))
  return promise
}

/** Test seam: cancels every open request and empties the queue. */
export function resetPasswordPrompt(): void {
  const entries = [...pending.values()]
  pending.clear()
  usePasswordPrompt.setState({ queue: [] })
  for (const entry of entries) entry.resolve(null)
}
