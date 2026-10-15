import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectionConfig } from "../../lib/connections"
import { setTransport } from "../../lib/ipc"
import { INITIAL_TABS } from "../../lib/queryTabs"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { useToastStore } from "../../components/ui/toastStore"
import { openConnection } from "../query/actions"
import { selectRows } from "../schema/actions"
import { connectMysql, isPasswordCancelled } from "./connectSession"
import { resetHostKeyPrompt, useHostKeyPrompt } from "./hostKeyPrompt"
import { HOST_KEY_DECLINED } from "./hostKeyTrust"
import { resetPasswordPrompt, usePasswordPrompt, type PasswordAnswer } from "./passwordPrompt"

const MYSQL: ConnectionConfig = {
  kind: "mysql",
  id: "m1",
  name: "Local",
  host: "localhost",
  port: 3306,
  user: "root",
  database: "app",
}

/** Fake backend with a keyring: `connections_save` stores the secret, `mysql_connect` records it. */
class FakeBackend {
  calls: { command: string; args?: Record<string, unknown> }[] = []
  secrets = new Map<string, string>()
  failSave = false
  /** Host key error `mysql_connect` rejects with until `ssh_trust_host` is called. */
  hostKeyError: { kind: string; message: string } | null = null
  trusted: Record<string, unknown>[] = []
  /** Connections whose key file is encrypted: connect needs a passphrase, given or stored. */
  encryptedKeys = new Set<string>()

  handle = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ command, args })
    switch (command) {
      case "connections_has_secret":
        return this.secrets.has(args?.which === "ssh" ? `${String(args.id)}:ssh` : String(args?.id))
      case "connections_save": {
        if (this.failSave) throw { kind: "credential", message: "User canceled the operation." }
        const config = args?.config as ConnectionConfig
        if (typeof args?.secret === "string") this.secrets.set(config.id, args.secret)
        if (typeof args?.sshSecret === "string")
          this.secrets.set(`${config.id}:ssh`, args.sshSecret)
        return config
      }
      case "ssh_trust_host":
        this.trusted.push(args ?? {})
        this.hostKeyError = null
        return undefined
      case "mysql_connect":
        if (this.hostKeyError) throw this.hostKeyError
        if (
          this.encryptedKeys.has(String(args?.connectionId)) &&
          args?.sshSecret === undefined &&
          !this.secrets.has(`${String(args?.connectionId)}:ssh`)
        ) {
          throw { kind: "ssh", message: "Key passphrase required for /k/id" }
        }
        return { serverVersion: "8.4", currentDatabase: null }
      case "mysql_databases":
        return ["app"]
      case "mysql_schema":
        return { database: "app", tables: [], fetchedAt: "2026-01-01T00:00:00Z" }
      case "mysql_query":
        return []
      default:
        throw { kind: "not_found", message: command }
    }
  }

  connects = () => this.calls.filter((c) => c.command === "mysql_connect").map((c) => c.args)
  count = (command: string) => this.calls.filter((c) => c.command === command).length
}

let fake: FakeBackend
let restore: () => void = () => {}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits for the prompt to open, then answers it. */
async function answerPrompt(
  answer: PasswordAnswer | null,
  which: "db" | "ssh" = "db",
  connectionId: string = MYSQL.id,
): Promise<void> {
  for (let i = 0; i < 10 && usePasswordPrompt.getState().queue.length === 0; i++) await flush()
  const [request] = usePasswordPrompt.getState().queue
  expect(request?.config.id).toBe(connectionId)
  expect(request?.which).toBe(which)
  usePasswordPrompt.getState().answer(request.id, answer)
}

/** Waits for the host key prompt, checks it, then answers it. */
async function answerHostKey(trust: boolean) {
  for (let i = 0; i < 10 && useHostKeyPrompt.getState().queue.length === 0; i++) await flush()
  const [request] = useHostKeyPrompt.getState().queue
  expect(request).toBeDefined()
  useHostKeyPrompt.getState().answer(request.id, trust)
  return request
}

beforeEach(() => {
  fake = new FakeBackend()
  restore = setTransport(fake.handle)
  useConnectionsStore.setState({ connections: [MYSQL] })
  useSessionsStore.setState({ sessions: {} })
  useTabsStore.setState({ ...INITIAL_TABS })
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  restore()
  resetPasswordPrompt()
  resetHostKeyPrompt()
  useConnectionsStore.setState({ connections: [] })
})

describe("connectMysql", () => {
  it("connects without asking when a secret is stored", async () => {
    fake.secrets.set(MYSQL.id, "stored")
    const info = await connectMysql(MYSQL.id)
    expect(info.currentDatabase).toBe("app")
    expect(usePasswordPrompt.getState().queue).toEqual([])
    expect(fake.connects()).toEqual([{ connectionId: MYSQL.id }])
  })

  it("uses the entered password for this session only when Remember is off", async () => {
    const connecting = connectMysql(MYSQL.id)
    await answerPrompt({ secret: "pw", remember: false })
    await connecting
    expect(fake.count("connections_save")).toBe(0)
    expect(fake.connects()).toEqual([{ connectionId: MYSQL.id, secret: "pw" }])
  })

  it("saves the password first when Remember is on, then connects normally", async () => {
    const connecting = connectMysql(MYSQL.id)
    await answerPrompt({ secret: "pw", remember: true })
    await connecting
    expect(fake.secrets.get(MYSQL.id)).toBe("pw")
    expect(fake.connects()).toEqual([{ connectionId: MYSQL.id }])
  })

  it("falls back to a session-only password when saving it fails", async () => {
    fake.failSave = true
    const connecting = connectMysql(MYSQL.id)
    await answerPrompt({ secret: "pw", remember: true })
    await connecting
    expect(fake.connects()).toEqual([{ connectionId: MYSQL.id, secret: "pw" }])
    const [toast] = useToastStore.getState().toasts
    expect(toast).toMatchObject({ tone: "warning" })
    expect(toast.detail).toContain("App file")
  })

  it("passes an empty password for accounts without one", async () => {
    const connecting = connectMysql(MYSQL.id)
    await answerPrompt({ secret: "", remember: false })
    await connecting
    expect(fake.connects()).toEqual([{ connectionId: MYSQL.id, secret: "" }])
  })

  it("rejects with the cancel marker and never connects when the prompt is cancelled", async () => {
    const connecting = connectMysql(MYSQL.id)
    await answerPrompt(null)
    const error = await connecting.catch((raw: unknown) => raw)
    expect(isPasswordCancelled(error)).toBe(true)
    expect(fake.count("mysql_connect")).toBe(0)
  })

  it("does not ask again once the session is connected", async () => {
    const first = connectMysql(MYSQL.id)
    await answerPrompt({ secret: "pw", remember: false })
    await first
    await connectMysql(MYSQL.id)
    expect(fake.connects()).toHaveLength(1)
    expect(usePasswordPrompt.getState().queue).toEqual([])
  })
})

describe("connect paths", () => {
  it("opening a connection goes through the prompt", async () => {
    const opening = openConnection(MYSQL.id)
    await answerPrompt({ secret: "pw", remember: false })
    await opening
    expect(fake.connects()).toEqual([{ connectionId: MYSQL.id, secret: "pw" }])
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })

  it("a cancelled prompt opens no tab", async () => {
    const opening = openConnection(MYSQL.id)
    await answerPrompt(null)
    await expect(opening).rejects.toSatisfy(isPasswordCancelled)
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })

  it("select rows asks first and stays quiet when cancelled", async () => {
    const selecting = selectRows(MYSQL.id, "app", "users")
    await answerPrompt(null)
    await selecting
    expect(fake.count("mysql_connect")).toBe(0)
    expect(useToastStore.getState().toasts).toEqual([])
    expect(useTabsStore.getState().tabs).toHaveLength(0)
  })
})

const VIA_PASSWORD: ConnectionConfig = {
  ...MYSQL,
  id: "s1",
  ssh: { host: "bastion", port: 22, user: "ops", auth: { type: "password" } },
}

const VIA_KEY: ConnectionConfig = {
  ...MYSQL,
  id: "s2",
  ssh: { host: "bastion", port: 22, user: "ops", auth: { type: "key", keyPath: "/k/id" } },
}

const VIA_AGENT: ConnectionConfig = {
  ...MYSQL,
  id: "s3",
  ssh: { host: "bastion", port: 22, user: "ops", auth: { type: "agent" } },
}

const KEY_LINE = "[bastion]:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoq"
const UNKNOWN_KEY = {
  kind: "ssh_host_key",
  message: `ssh-ed25519 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s is the host key of bastion:22, which is not in known_hosts. Trust it only if the fingerprint matches the server's.\n${KEY_LINE}`,
}

describe("SSH secrets", () => {
  beforeEach(() => {
    useConnectionsStore.setState({ connections: [VIA_PASSWORD, VIA_KEY, VIA_AGENT] })
  })

  it("asks for the SSH password after the database password, for this session only", async () => {
    const connecting = connectMysql(VIA_PASSWORD.id)
    await answerPrompt({ secret: "db", remember: false }, "db", VIA_PASSWORD.id)
    await answerPrompt({ secret: "tunnel", remember: false }, "ssh", VIA_PASSWORD.id)
    await connecting
    expect(fake.count("connections_save")).toBe(0)
    expect(fake.connects()).toEqual([
      { connectionId: VIA_PASSWORD.id, secret: "db", sshSecret: "tunnel" },
    ])
  })

  it("connects with an unencrypted key file without asking for a passphrase", async () => {
    fake.secrets.set(VIA_KEY.id, "stored")
    await connectMysql(VIA_KEY.id)
    expect(usePasswordPrompt.getState().queue).toEqual([])
    expect(fake.connects()).toEqual([{ connectionId: VIA_KEY.id }])
    const lookups = fake.calls.filter((c) => c.command === "connections_has_secret")
    expect(lookups.map((c) => c.args)).toEqual([{ id: VIA_KEY.id }])
  })

  it("asks for the passphrase when the backend needs one, then connects again", async () => {
    fake.secrets.set(VIA_KEY.id, "stored")
    fake.encryptedKeys.add(VIA_KEY.id)
    const connecting = connectMysql(VIA_KEY.id)
    await answerPrompt({ secret: "phrase", remember: false }, "ssh", VIA_KEY.id)
    await connecting
    expect(fake.count("connections_save")).toBe(0)
    expect(fake.connects()).toEqual([
      { connectionId: VIA_KEY.id },
      { connectionId: VIA_KEY.id, sshSecret: "phrase" },
    ])
    expect(useSessionsStore.getState().sessions[VIA_KEY.id]?.state).toBe("connected")
  })

  it("saves a remembered passphrase and connects with the store", async () => {
    fake.secrets.set(VIA_KEY.id, "stored")
    fake.encryptedKeys.add(VIA_KEY.id)
    const connecting = connectMysql(VIA_KEY.id)
    await answerPrompt({ secret: "phrase", remember: true }, "ssh", VIA_KEY.id)
    await connecting
    const save = fake.calls.find((c) => c.command === "connections_save")
    expect(save?.args).toMatchObject({ secret: null, sshSecret: "phrase" })
    expect(fake.connects()).toEqual([{ connectionId: VIA_KEY.id }, { connectionId: VIA_KEY.id }])
  })

  it("does not ask for a passphrase on other SSH errors", async () => {
    fake.secrets.set(VIA_KEY.id, "stored")
    fake.hostKeyError = { kind: "ssh", message: "SSH key authentication failed: refused" }
    await expect(connectMysql(VIA_KEY.id)).rejects.toEqual(fake.hostKeyError)
    expect(usePasswordPrompt.getState().queue).toEqual([])
    expect(fake.connects()).toHaveLength(1)
  })

  it("saves remembered secrets in one request and connects with the store", async () => {
    const connecting = connectMysql(VIA_PASSWORD.id)
    await answerPrompt({ secret: "db", remember: true }, "db", VIA_PASSWORD.id)
    await answerPrompt({ secret: "tunnel", remember: true }, "ssh", VIA_PASSWORD.id)
    await connecting
    expect(fake.count("connections_save")).toBe(1)
    expect(fake.secrets.get(VIA_PASSWORD.id)).toBe("db")
    expect(fake.secrets.get(`${VIA_PASSWORD.id}:ssh`)).toBe("tunnel")
    expect(fake.connects()).toEqual([{ connectionId: VIA_PASSWORD.id }])
  })

  it("remembers only the SSH secret and keeps the database password for the session", async () => {
    const connecting = connectMysql(VIA_PASSWORD.id)
    await answerPrompt({ secret: "db", remember: false }, "db", VIA_PASSWORD.id)
    await answerPrompt({ secret: "tunnel", remember: true }, "ssh", VIA_PASSWORD.id)
    await connecting
    const save = fake.calls.find((c) => c.command === "connections_save")
    expect(save?.args).toMatchObject({ secret: null, sshSecret: "tunnel" })
    expect(fake.connects()).toEqual([{ connectionId: VIA_PASSWORD.id, secret: "db" }])
  })

  it("does not ask when both secrets are stored, or for agent auth", async () => {
    fake.secrets.set(VIA_PASSWORD.id, "db")
    fake.secrets.set(`${VIA_PASSWORD.id}:ssh`, "tunnel")
    fake.secrets.set(VIA_AGENT.id, "db")
    await connectMysql(VIA_PASSWORD.id)
    await connectMysql(VIA_AGENT.id)
    expect(usePasswordPrompt.getState().queue).toEqual([])
    expect(fake.connects()).toEqual([
      { connectionId: VIA_PASSWORD.id },
      { connectionId: VIA_AGENT.id },
    ])
    const lookups = fake.calls.filter((c) => c.command === "connections_has_secret")
    expect(lookups.map((c) => c.args)).toEqual([
      { id: VIA_PASSWORD.id },
      { id: VIA_PASSWORD.id, which: "ssh" },
      { id: VIA_AGENT.id },
    ])
  })

  it("rejects with the cancel marker when an SSH prompt is cancelled", async () => {
    fake.secrets.set(VIA_PASSWORD.id, "stored")
    const connecting = connectMysql(VIA_PASSWORD.id)
    await answerPrompt(null, "ssh", VIA_PASSWORD.id)
    await expect(connecting).rejects.toSatisfy(isPasswordCancelled)
    expect(fake.count("mysql_connect")).toBe(0)

    fake.secrets.set(VIA_KEY.id, "stored")
    fake.encryptedKeys.add(VIA_KEY.id)
    const unlocking = connectMysql(VIA_KEY.id)
    await answerPrompt(null, "ssh", VIA_KEY.id)
    await expect(unlocking).rejects.toSatisfy(isPasswordCancelled)
    expect(fake.connects()).toHaveLength(1)
  })
})

describe("SSH host keys", () => {
  beforeEach(() => {
    useConnectionsStore.setState({ connections: [VIA_AGENT] })
    fake.secrets.set(VIA_AGENT.id, "db")
  })

  it("trusts the key the user accepted, then connects again", async () => {
    fake.hostKeyError = UNKNOWN_KEY
    const connecting = connectMysql(VIA_AGENT.id)
    const request = await answerHostKey(true)
    expect(request.target).toEqual({ host: "bastion", port: 22 })
    expect(request.details?.fingerprint).toBe("SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s")
    await connecting
    expect(fake.trusted).toEqual([{ host: "bastion", port: 22, keyLine: KEY_LINE }])
    expect(fake.connects()).toHaveLength(2)
    expect(useSessionsStore.getState().sessions[VIA_AGENT.id]?.state).toBe("connected")
  })

  it("stays quiet and saves nothing when the user declines", async () => {
    fake.hostKeyError = UNKNOWN_KEY
    const connecting = connectMysql(VIA_AGENT.id)
    await answerHostKey(false)
    const error = await connecting.catch((raw: unknown) => raw)
    expect(error).toBe(HOST_KEY_DECLINED)
    expect(isPasswordCancelled(error)).toBe(true)
    expect(fake.trusted).toEqual([])
    expect(fake.connects()).toHaveLength(1)
  })

  it("never trusts a changed key and rejects with the backend error", async () => {
    fake.hostKeyError = {
      kind: "ssh_host_key",
      message: `ssh-ed25519 SHA256:abc: the host key of bastion:22 changed (known_hosts line 3 has a different key).\n${KEY_LINE}`,
    }
    const connecting = connectMysql(VIA_AGENT.id)
    const request = await answerHostKey(true)
    expect(request.details?.changed).toBe(true)
    await expect(connecting).rejects.toEqual(fake.hostKeyError)
    expect(fake.trusted).toEqual([])
  })

  it("asks once for concurrent connects to the same server", async () => {
    fake.hostKeyError = UNKNOWN_KEY
    const opening = openConnection(VIA_AGENT.id)
    const selecting = selectRows(VIA_AGENT.id, "app", "users")
    await answerHostKey(true)
    await Promise.all([opening, selecting])
    expect(fake.trusted).toHaveLength(1)
    expect(useHostKeyPrompt.getState().queue).toEqual([])
  })
})
