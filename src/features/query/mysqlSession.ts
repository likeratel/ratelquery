import { showToast } from "../../components/ui"
import type { ConnectionId } from "../../lib/connections"
import { normalizeError } from "../../lib/ipc"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { connectMysql, isPasswordCancelled } from "../connections/connectSession"
import { errorDetail } from "../connections/errors"

export type SessionOutcome = "ready" | "cancelled" | "failed"

/**
 * Session states that need no connect: open, or recovering on its own. `error` is here too: its
 * pool may still be there, and the existing retry path handles it.
 */
const USABLE_STATES = new Set(["connected", "reconnecting", "error"])

/**
 * Opens the MySQL session of a tab that has none, such as one reopened from the last run, asking
 * for the password when none is stored. A connect already in flight is joined. A failed connect
 * is reported here; a cancelled prompt is the user's choice and shows nothing.
 */
export async function ensureMysqlSession(connectionId: ConnectionId): Promise<SessionOutcome> {
  const state = useSessionsStore.getState().sessions[connectionId]?.state
  if (state && USABLE_STATES.has(state)) return "ready"
  try {
    await connectMysql(connectionId)
    return "ready"
  } catch (raw) {
    if (isPasswordCancelled(raw)) return "cancelled"
    const name = useConnectionsStore.getState().byId(connectionId)?.name ?? "the connection"
    showToast({
      tone: "error",
      message: `Couldn't connect to ${name}`,
      detail: errorDetail(normalizeError(raw)),
    })
    return "failed"
  }
}

/** What the MySQL database picker saw. Focus alone never connects (see `createSwitcherOpener`). */
export type SwitcherInput =
  | { type: "focus" }
  | { type: "pointerdown"; button: number; timeStamp: number }
  | { type: "keydown"; code: string; timeStamp: number }

/** `KeyboardEvent.code`s that open a native select. */
const OPEN_KEYS: ReadonlySet<string> = new Set(["Enter", "NumpadEnter", "Space", "ArrowDown"])

/** True for a press that means "show me the databases": a primary click or an opening key. */
export function isOpenIntent(input: SwitcherInput): boolean {
  if (input.type === "pointerdown") return input.button === 0
  if (input.type === "keydown") return OPEN_KEYS.has(input.code)
  return false
}

export interface SwitcherOpenerDeps {
  /** True when the connection has no usable session yet. */
  needsSession: (id: ConnectionId) => boolean
  ensureSession: (id: ConnectionId) => Promise<SessionOutcome>
  now: () => number
}

/**
 * Handles input on the MySQL database picker of a tab without a usable session (an open one
 * lists its databases on focus as before). Only an explicit press connects, never focus: closing the password prompt puts focus back on the picker, and a focus
 * trigger would ask again at once. One connect runs per connection at a time, and presses that
 * happened before a cancelled prompt closed (queued while it was open) are ignored, so a
 * cancel is only undone by a new press. Returns true when it started a connect.
 */
export function createSwitcherOpener(deps: SwitcherOpenerDeps) {
  const connecting = new Set<ConnectionId>()
  const cancelledAt = new Map<ConnectionId, number>()

  return (id: ConnectionId, input: SwitcherInput): boolean => {
    if (input.type === "focus" || !isOpenIntent(input) || !deps.needsSession(id)) return false
    const cancelled = cancelledAt.get(id)
    if (connecting.has(id) || (cancelled !== undefined && input.timeStamp <= cancelled)) {
      return false
    }
    connecting.add(id)
    void deps.ensureSession(id).then((outcome) => {
      connecting.delete(id)
      if (outcome === "cancelled") cancelledAt.set(id, deps.now())
      else cancelledAt.delete(id)
    })
    return true
  }
}

/** True when the connection has no usable MySQL session. */
export const needsMysqlSession = (id: ConnectionId) => {
  const state = useSessionsStore.getState().sessions[id]?.state
  return !state || !USABLE_STATES.has(state)
}

/** The app's picker handler, shared by every MySQL tab. */
export const openMysqlSwitcher = createSwitcherOpener({
  needsSession: needsMysqlSession,
  ensureSession: ensureMysqlSession,
  now: () => performance.now(),
})
