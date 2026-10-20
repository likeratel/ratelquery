import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectionConfig } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import { setTransport, type AppError } from "../../lib/ipc"
import { useConnectionsStore } from "../../state/connectionsStore"
import { formFromConfig, MYSQL_SECRET_AGAIN, parseForm } from "./form"
import { resetHostKeyPrompt, useHostKeyPrompt } from "./hostKeyPrompt"

/** In-memory stand-in for the Tauri backend's connections commands. */
class FakeBackend {
  configs = new Map<string, ConnectionConfig>()
  secrets = new Map<string, string>()
  failures = new Map<string, AppError>()
  /** Rejection of `connections_test` until `ssh_trust_host` is called. */
  hostKeyError: AppError | null = null
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
      case "connections_duplicate": {
        const source = this.configs.get(args?.id as string)
        if (!source) throw { kind: "not_found", message: "gone" }
        const copy = { ...source, id: `id-${this.nextId++}`, name: `${source.name} copy` }
        this.configs.set(copy.id, copy)
        return copy
      }
      case "connections_has_secret":
        return this.secrets.has(
          args?.which === "ssh" ? `${args.id as string}:ssh` : (args?.id as string),
        )
      case "ssh_trust_host":
        this.hostKeyError = null
        return undefined
      case "connections_test":
        if (this.hostKeyError) throw this.hostKeyError
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

afterEach(() => {
  restore()
  resetHostKeyPrompt()
})

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
      summary: "Couldn't load connections. Couldn't read or write the connection settings file.",
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

  it("assumes a stored secret when the lookup fails, so a new server asks for it", async () => {
    const existing = mysql({ id: "m1" })
    backend.failures.set("connections_has_secret", { kind: "credential", message: "locked" })
    useConnectionsStore.getState().openDialog(existing)
    await flush()
    const { hasStoredSecret } = useConnectionsStore.getState().dialog
    expect(hasStoredSecret).toBe(true)
    const context = { original: existing, hasStoredSecret }
    const moved = formFromConfig({ ...existing, host: "other.example" } as ConnectionConfig)
    expect(parseForm(moved, context)).toEqual({
      ok: false,
      errors: { password: MYSQL_SECRET_AGAIN },
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
      "Couldn't save the connection. Some fields are not valid.",
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
        summary: "Couldn't delete the connection. This connection no longer exists.",
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
          "Couldn't delete the connection. Credentials were rejected or couldn't be read from the keychain.",
        detail: "keychain locked",
      },
    })
    expect(useConnectionsStore.getState().connections.map((c) => c.id)).toEqual(["m2"])
    expect(removed).toEqual(["m1"])
  })
})

describe("duplicate", () => {
  it("lists the copy in name order without opening the dialog", async () => {
    const source = mysql({ id: "m1", name: "Prod" })
    backend.configs.set("m1", source)
    useConnectionsStore.setState({ connections: [source, mysql({ id: "z", name: "Zeta" })] })
    const result = await useConnectionsStore.getState().duplicate("m1")
    expect(result).toEqual({ ok: true, value: { ...source, id: "id-1", name: "Prod copy" } })
    const state = useConnectionsStore.getState()
    expect(state.connections.map((c) => c.name)).toEqual(["Prod", "Prod copy", "Zeta"])
    expect(state.dialog.open).toBe(false)
    // Only the id crosses IPC; secrets stay in the backend.
    expect(backend.calls.at(-1)).toEqual({ command: "connections_duplicate", args: { id: "m1" } })
  })

  it("reports failures with a friendly error and keeps the list", async () => {
    useConnectionsStore.setState({ connections: [mysql({ id: "m1" })] })
    const result = await useConnectionsStore.getState().duplicate("m1")
    expect(result).toEqual({
      ok: false,
      error: {
        summary: "Couldn't duplicate the connection. This connection no longer exists.",
        detail: "gone",
      },
    })
    expect(useConnectionsStore.getState().connections).toHaveLength(1)
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
        summary: "Couldn't reach the server. Check the host, port and network.",
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

describe("SSH", () => {
  const viaSsh = mysql({
    id: "m1",
    ssh: { host: "bastion", port: 22, user: "ops", auth: { type: "password" } },
  } as Partial<ConnectionConfig>)

  it("looks up the stored SSH secret when editing a tunnelled connection", async () => {
    backend.secrets.set("m1:ssh", "tunnel")
    useConnectionsStore.getState().openDialog(viaSsh)
    await flush()
    expect(useConnectionsStore.getState().dialog).toMatchObject({
      hasStoredSecret: false,
      hasStoredSshSecret: true,
    })
    const lookups = backend.calls.filter((c) => c.command === "connections_has_secret")
    expect(lookups.map((c) => c.args)).toEqual([{ id: "m1" }, { id: "m1", which: "ssh" }])
  })

  it("does not look up an SSH secret for a connection without a tunnel", async () => {
    useConnectionsStore.getState().openDialog(mysql({ id: "m2" }))
    await flush()
    expect(useConnectionsStore.getState().dialog.hasStoredSshSecret).toBe(false)
    expect(backend.calls.filter((c) => c.command === "connections_has_secret")).toHaveLength(1)
  })

  it("passes the SSH secret to save and test", async () => {
    await useConnectionsStore.getState().save(viaSsh, null, "tunnel")
    expect(backend.calls.at(-1)?.args).toEqual({
      config: viaSsh,
      secret: null,
      sshSecret: "tunnel",
    })
    await useConnectionsStore.getState().testConnection(viaSsh, "pw", null)
    expect(backend.calls.at(-1)?.args).toEqual({ config: viaSsh, secret: "pw", sshSecret: null })
  })

  it("tests again after the user trusts an unknown host key", async () => {
    backend.hostKeyError = {
      kind: "ssh_host_key",
      message:
        "ssh-ed25519 SHA256:abcdef is the host key of bastion:22, which is not in known_hosts.\nbastion ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA",
    }
    const pending = useConnectionsStore.getState().testConnection(viaSsh, null)
    for (let i = 0; i < 10 && useHostKeyPrompt.getState().queue.length === 0; i++) await flush()
    expect(useConnectionsStore.getState().test).toEqual({ status: "testing" })
    const [request] = useHostKeyPrompt.getState().queue
    useHostKeyPrompt.getState().answer(request.id, true)
    await pending
    expect(useConnectionsStore.getState().test).toMatchObject({ status: "ok" })
    expect(backend.calls.map((c) => c.command)).toEqual([
      "connections_test",
      "ssh_trust_host",
      "connections_test",
    ])
  })

  it("reports SSH failures with a direct summary", async () => {
    backend.failures.set("connections_test", { kind: "ssh", message: "auth rejected (password)" })
    await useConnectionsStore.getState().testConnection(viaSsh, null)
    expect(useConnectionsStore.getState().test).toEqual({
      status: "fail",
      error: { summary: "SSH connection failed.", detail: "auth rejected (password)" },
    })
  })
})
