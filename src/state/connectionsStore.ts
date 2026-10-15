import { create } from "zustand"
import { connectionsApi, type ConnectionConfig, type ConnectionId } from "../lib/connections"
import { emitAppEvent } from "../lib/events"
import { normalizeError } from "../lib/ipc"
import {
  describeError,
  type ConnectionAction,
  type FriendlyError,
} from "../features/connections/errors"
import { sortByName, upsertConnection } from "../features/connections/filter"
import { withHostKeyTrust } from "../features/connections/hostKeyTrust"

export type LoadStatus = "idle" | "loading" | "ready" | "error"

export type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; latencyMs: number; serverVersion?: string }
  | { status: "fail"; error: FriendlyError }

export interface DialogState {
  open: boolean
  /** Connection being edited, or null when creating a new one. */
  editing: ConnectionConfig | null
  /** True once the backend confirms a secret is stored for `editing`. */
  hasStoredSecret: boolean
  /** True once the backend confirms an SSH password or key passphrase is stored for `editing`. */
  hasStoredSshSecret: boolean
  /** Increments on every open so stale async results can be ignored. */
  session: number
}

export type ActionResult<T = void> =
  { ok: true; value: T; warning?: FriendlyError } | { ok: false; error: FriendlyError }

interface ConnectionsState {
  connections: ConnectionConfig[]
  status: LoadStatus
  loadError: FriendlyError | null
  dialog: DialogState
  test: TestState
  saving: boolean
  saveError: FriendlyError | null
  load: () => Promise<void>
  openDialog: (existing?: ConnectionConfig) => void
  closeDialog: () => void
  /** `sshSecret` follows the same rule as `secret`: null keeps, "" clears, omitted keeps. */
  save: (
    config: ConnectionConfig,
    secret: string | null,
    sshSecret?: string | null,
  ) => Promise<ActionResult<ConnectionConfig>>
  remove: (id: ConnectionId) => Promise<ActionResult>
  /** Tests through the SSH tunnel when the config has one, asking about unknown host keys. */
  testConnection: (
    config: ConnectionConfig,
    secret: string | null,
    sshSecret?: string | null,
  ) => Promise<void>
  resetTest: () => void
  byId: (id: ConnectionId) => ConnectionConfig | undefined
}

const IDLE_TEST: TestState = { status: "idle" }

const CLOSED_DIALOG: DialogState = {
  open: false,
  editing: null,
  hasStoredSecret: false,
  hasStoredSshSecret: false,
  session: 0,
}

function friendly(raw: unknown, action: ConnectionAction): FriendlyError {
  return describeError(normalizeError(raw), action)
}

/**
 * Whether a secret is stored. Unknown keyring state counts as stored (the safe side): moving
 * the connection to another server then asks for the secret again instead of reusing whatever
 * is stored. A blank secret for the same server still means "keep".
 */
const storedOrUnknown = (lookup: Promise<boolean>) => lookup.catch(() => true)

let loadToken = 0
let testToken = 0

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  connections: [],
  status: "idle",
  loadError: null,
  dialog: CLOSED_DIALOG,
  test: IDLE_TEST,
  saving: false,
  saveError: null,

  load: async () => {
    const token = ++loadToken
    set({ status: "loading", loadError: null })
    try {
      const list = await connectionsApi.list()
      if (token !== loadToken) return
      set({ connections: sortByName(list), status: "ready" })
    } catch (raw) {
      if (token !== loadToken) return
      set({ status: "error", loadError: friendly(raw, "load") })
    }
  },

  openDialog: (existing) => {
    const session = get().dialog.session + 1
    testToken++
    set({
      dialog: {
        open: true,
        editing: existing ?? null,
        hasStoredSecret: false,
        hasStoredSshSecret: false,
        session,
      },
      test: IDLE_TEST,
      saving: false,
      saveError: null,
    })
    if (!existing) return
    const update = (patch: Partial<DialogState>) => {
      const { dialog } = get()
      if (dialog.open && dialog.session === session) set({ dialog: { ...dialog, ...patch } })
    }
    void storedOrUnknown(connectionsApi.hasSecret(existing.id)).then((hasStoredSecret) =>
      update({ hasStoredSecret }),
    )
    if (existing.kind === "mysql" && existing.ssh) {
      void storedOrUnknown(connectionsApi.hasSecret(existing.id, "ssh")).then(
        (hasStoredSshSecret) => update({ hasStoredSshSecret }),
      )
    }
  },

  closeDialog: () => {
    testToken++
    set((state) => ({
      dialog: { ...CLOSED_DIALOG, session: state.dialog.session },
      test: IDLE_TEST,
      saving: false,
      saveError: null,
    }))
  },

  save: async (config, secret, sshSecret) => {
    const session = get().dialog.session
    set({ saving: true, saveError: null })
    try {
      const saved = await connectionsApi.save(config, secret, sshSecret)
      set((state) => ({ connections: upsertConnection(state.connections, saved) }))
      if (get().dialog.session === session) get().closeDialog()
      return { ok: true, value: saved }
    } catch (raw) {
      const error = friendly(raw, "save")
      if (get().dialog.session === session) set({ saving: false, saveError: error })
      return { ok: false, error }
    }
  },

  remove: async (id) => {
    const forget = () => {
      set((state) => ({ connections: state.connections.filter((c) => c.id !== id) }))
      // Tabs, sessions and caches subscribe to this to clean up after the deleted connection.
      emitAppEvent("connection-removed", id)
    }
    try {
      await connectionsApi.delete(id)
      forget()
      return { ok: true, value: undefined }
    } catch (raw) {
      const error = normalizeError(raw)
      // The backend removes the config even when the keyring refuses to delete the secret;
      // treat that as removed and surface the leftover secret as a warning.
      if (error.kind === "credential") {
        forget()
        return { ok: true, value: undefined, warning: describeError(error, "delete") }
      }
      return { ok: false, error: describeError(error, "delete") }
    }
  },

  testConnection: async (config, secret, sshSecret) => {
    const token = ++testToken
    set({ test: { status: "testing" } })
    const ssh = config.kind === "mysql" ? config.ssh : undefined
    try {
      // An unknown host key asks the user; once trusted, the test runs again.
      const result = await withHostKeyTrust(ssh, () =>
        connectionsApi.test(config, secret, sshSecret),
      )
      if (token !== testToken) return
      set({
        test: { status: "ok", latencyMs: result.latencyMs, serverVersion: result.serverVersion },
      })
    } catch (raw) {
      if (token !== testToken) return
      set({ test: { status: "fail", error: friendly(raw, "test") } })
    }
  },

  resetTest: () => {
    testToken++
    set({ test: IDLE_TEST })
  },

  byId: (id) => get().connections.find((c) => c.id === id),
}))
