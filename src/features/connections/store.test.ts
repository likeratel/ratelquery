import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectionConfig } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import { setTransport, type AppError } from "../../lib/ipc"
import { useConnectionsStore } from "../../state/connectionsStore"

/** In-memory stand-in for the Tauri backend's connections commands. */
class FakeBackend {
  configs = new Map<string, ConnectionConfig>()
  secrets = new Map<string, string>()
  failures = new Map<string, AppError>()
  calls: { command: string; args?: Record<string, unknown> }[] = []
  private nextId = 1
  private pending: (() => void)[] = []
  hold = false

  transport = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    this.calls = [...this.calls, { command, args }]
    if (this.hold) await new Promise<void>((resolve) => this.pending.push(resolve))
    const failure = this.failures.get(command)
    if (failure) throw failure
    switch (command) {
      case "connections_list":
        return [...this.configs.values()]
      case "connections_save": {
        const config = args?.config as ConnectionConfig
        const id = config.id || `id-${this.nextId++}`
        const saved = { ...config, id }
        this.configs.set(id, saved)
        const secret = args?.secret as string | null
        if (secret === "") this.secrets.delete(id)
        else if (secret !== null) this.secrets.set(id, secret)
        return saved
      }
      case "connections_delete":
        this.configs.delete(args?.id as string)
        this.secrets.delete(args?.id as string)
        return undefined
      case "connections_has_secret":
        return this.secrets.has(args?.id as string)
      case "connections_test":
        return { ok: true, serverVersion: "8.0.36", latencyMs: 12 }
      default:
        throw { kind: "unknown", message: `unexpected ${command}` }
    }
  }

  release() {
    this.hold = false
    const pending = this.pending
    this.pending = []
    pending.forEach((resolve) => resolve())
  }
}

const mysql = (patch: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({
    kind: "mysql",
    id: "",
    name: "Local",
    host: "localhost",
    port: 3306,
    user: "root",
    ...patch,
  }) as ConnectionConfig

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let backend: FakeBackend
let restore: () => void
const initial = useConnectionsStore.getState()

beforeEach(() => {
  backend = new FakeBackend()
  restore = setTransport(backend.transport)
  useConnectionsStore.setState(initial, true)
})

afterEach(() => restore())

describe("load", () => {
  it("loads and sorts connections by name", async () => {
    backend.configs.set("b", mysql({ id: "b", name: "beta" }))
    backend.configs.set("a", mysql({ id: "a", name: "Alpha" }))
    await useConnectionsStore.getState().load()
    const state = useConnectionsStore.getState()
    expect(state.status).toBe("ready")
    expect(state.connections.map((c) => c.id)).toEqual(["a", "b"])
    expect(state.byId("b")?.name).toBe("beta")
  })

  it("maps failures to a friendly error", async () => {
    backend.failures.set("connections_list", { kind: "io", message: "EACCES" })
    await useConnectionsStore.getState().load()
    const state = useConnectionsStore.getState()
    expect(state.status).toBe("error")
    expect(state.loadError).toEqual({
      summary: "Could not load connections. Could not read or write the connection settings file.",
      detail: "EACCES",
    })
  })
})

describe("dialog", () => {
  it("opens for a new connection and closes", () => {
    useConnectionsStore.getState().openDialog()
    expect(useConnectionsStore.getState().dialog).toMatchObject({ open: true, editing: null })
    useConnectionsStore.getState().closeDialog()
    expect(useConnectionsStore.getState().dialog.open).toBe(false)
  })

  it("looks up whether a secret is stored when editing", async () => {
    const existing = mysql({ id: "m1" })
    backend.secrets.set("m1", "pw")
    useConnectionsStore.getState().openDialog(existing)
    expect(useConnectionsStore.getState().dialog.hasStoredSecret).toBe(false)
    await flush()
    expect(useConnectionsStore.getState().dialog).toMatchObject({
      open: true,
      editing: existing,
      hasStoredSecret: true,
    })
  })
})

describe("save", () => {
  it("inserts the saved config, stores the secret and closes the dialog", async () => {
    const store = useConnectionsStore.getState()
    store.openDialog()
    const result = await store.save(mysql(), "secret")
    expect(result).toMatchObject({ ok: true, value: { id: "id-1" } })
    const state = useConnectionsStore.getState()
    expect(state.connections.map((c) => c.id)).toEqual(["id-1"])
    expect(state.dialog.open).toBe(false)
    expect(backend.secrets.get("id-1")).toBe("secret")
  })

  it("replaces an edited connection in place", async () => {
    useConnectionsStore.setState({ connections: [mysql({ id: "m1", name: "Old" })] })
    const before = useConnectionsStore.getState().connections
    await useConnectionsStore.getState().save(mysql({ id: "m1", name: "New" }), null)
    const after = useConnectionsStore.getState().connections
    expect(after.map((c) => c.name)).toEqual(["New"])
    expect(before[0].name).toBe("Old")
  })

  it("keeps the dialog open with a friendly error on failure", async () => {
    backend.failures.set("connections_save", { kind: "invalid_input", message: "name empty" })
    const store = useConnectionsStore.getState()
    store.openDialog()
    const result = await store.save(mysql(), null)
    expect(result.ok).toBe(false)
    const state = useConnectionsStore.getState()
    expect(state.dialog.open).toBe(true)
    expect(state.saving).toBe(false)
    expect(state.saveError?.summary).toBe(
      "Could not save the connection. Some fields are not valid.",
    )
  })
})

describe("remove", () => {
  it("removes the connection", async () => {
    useConnectionsStore.setState({ connections: [mysql({ id: "m1" }), mysql({ id: "m2" })] })
    const result = await useConnectionsStore.getState().remove("m1")
    expect(result.ok).toBe(true)
    expect(useConnectionsStore.getState().connections.map((c) => c.id)).toEqual(["m2"])
  })

  it("keeps the list and reports the error on failure", async () => {
    backend.failures.set("connections_delete", { kind: "not_found", message: "gone" })
    useConnectionsStore.setState({ connections: [mysql({ id: "m1" })] })
    const result = await useConnectionsStore.getState().remove("m1")
    expect(result).toEqual({
      ok: false,
      error: {
        summary: "Could not delete the connection. This connection no longer exists.",
        detail: "gone",
      },
    })
    expect(useConnectionsStore.getState().connections).toHaveLength(1)
  })

  it("removes the connection but warns when the keychain keeps the secret", async () => {
    backend.failures.set("connections_delete", { kind: "credential", message: "keychain locked" })
    useConnectionsStore.setState({ connections: [mysql({ id: "m1" }), mysql({ id: "m2" })] })
    const removed: string[] = []
    const stop = onAppEvent("connection-removed", (id) => removed.push(id))
    const result = await useConnectionsStore.getState().remove("m1")
    stop()
    expect(result).toEqual({
      ok: true,
      value: undefined,
      warning: {
        summary:
          "Could not delete the connection. Credentials were rejected or could not be read from the keychain.",
        detail: "keychain locked",
      },
    })
    expect(useConnectionsStore.getState().connections.map((c) => c.id)).toEqual(["m2"])
    expect(removed).toEqual(["m1"])
  })
})

describe("testConnection", () => {
  it("moves from testing to ok with latency and version", async () => {
    const pending = useConnectionsStore.getState().testConnection(mysql(), "pw")
    expect(useConnectionsStore.getState().test).toEqual({ status: "testing" })
    await pending
    expect(useConnectionsStore.getState().test).toEqual({
      status: "ok",
      latencyMs: 12,
      serverVersion: "8.0.36",
    })
    expect(backend.calls.at(-1)?.args).toEqual({ config: mysql(), secret: "pw" })
  })

  it("reports connection failures", async () => {
    backend.failures.set("connections_test", { kind: "connection", message: "ECONNREFUSED" })
    await useConnectionsStore.getState().testConnection(mysql(), null)
    expect(useConnectionsStore.getState().test).toEqual({
      status: "fail",
      error: {
        summary: "Could not reach the server. Check the host, port and network.",
        detail: "ECONNREFUSED",
      },
    })
  })

  it("ignores a result that arrives after the dialog closed", async () => {
    backend.hold = true
    const store = useConnectionsStore.getState()
    store.openDialog()
    const pending = store.testConnection(mysql(), null)
    store.closeDialog()
    backend.release()
    await pending
    expect(useConnectionsStore.getState().test).toEqual({ status: "idle" })
  })
})
