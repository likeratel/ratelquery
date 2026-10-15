import { create } from "zustand"
import { parseHostKeyMessage, type HostKeyDetails } from "../../lib/ssh"

/** An SSH server whose host key the user is asked about. */
export interface HostKeyTarget {
  host: string
  port: number
}

export interface HostKeyRequest {
  /** Unique per request, so the dialog starts fresh for each one. */
  id: number
  target: HostKeyTarget
  /** Raw `ssh_host_key` message, shown when it can't be read. */
  message: string
  /** What the message says about the key, or null when it doesn't follow the contract. */
  details: HostKeyDetails | null
}

interface HostKeyPromptState {
  /** Waiting requests, oldest first; the dialog shows the first one. */
  queue: readonly HostKeyRequest[]
  /** Settles the request: true when the user trusts the key. */
  answer: (requestId: number, trust: boolean) => void
}

interface Pending {
  key: string
  promise: Promise<boolean>
  resolve: (trust: boolean) => void
}

let nextRequestId = 0
const pending = new Map<number, Pending>()

const targetKey = ({ host, port }: HostKeyTarget) => `${host.toLowerCase()}:${port}`

export const useHostKeyPrompt = create<HostKeyPromptState>((set) => ({
  queue: [],
  answer: (requestId, trust) => {
    const entry = pending.get(requestId)
    pending.delete(requestId)
    set((state) => ({ queue: state.queue.filter((r) => r.id !== requestId) }))
    entry?.resolve(trust)
  },
}))

/**
 * Shows the host key from an `ssh_host_key` error and asks whether to trust it. Resolves with
 * true when the user trusts it, false when they cancel (a changed key can only be dismissed).
 * Callers asking about the same server while a prompt is open share it.
 */
export function requestHostKeyTrust(target: HostKeyTarget, message: string): Promise<boolean> {
  const key = targetKey(target)
  for (const entry of pending.values()) {
    if (entry.key === key) return entry.promise
  }
  const id = ++nextRequestId
  let resolve: (trust: boolean) => void = () => {}
  const promise = new Promise<boolean>((r) => (resolve = r))
  pending.set(id, { key, promise, resolve })
  const request: HostKeyRequest = { id, target, message, details: parseHostKeyMessage(message) }
  useHostKeyPrompt.setState((state) => ({ queue: [...state.queue, request] }))
  return promise
}

/** Test seam: declines every open request and empties the queue. */
export function resetHostKeyPrompt(): void {
  const entries = [...pending.values()]
  pending.clear()
  useHostKeyPrompt.setState({ queue: [] })
  for (const entry of entries) entry.resolve(false)
}
