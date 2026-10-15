/** Tracks whether a cell editor already finished, so its closing blur can't commit again. */
export interface CommitGate {
  done: boolean
}

export interface CommitHandlers {
  /** Returns an error message to keep editing, or null when the value was accepted. */
  onCommit: (text: string) => string | null
  onCancel: () => void
}

/**
 * Commits `text` (or cancels when it is unchanged) at most once. The gate closes before the
 * handlers run: a successful commit unmounts the editor and moves focus, and the blur that
 * follows re-enters while `onCommit` is still on the stack. A rejected value reopens the gate.
 * Returns the error message, or null when the editor is done.
 */
export function commitOnce(
  gate: CommitGate,
  text: string,
  initial: string,
  handlers: CommitHandlers,
): string | null {
  if (gate.done) return null
  gate.done = true
  if (text === initial) {
    handlers.onCancel()
    return null
  }
  const message = handlers.onCommit(text)
  if (message !== null) gate.done = false
  return message
}
