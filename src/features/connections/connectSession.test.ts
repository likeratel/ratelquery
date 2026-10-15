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

  handle = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ command, args })
    switch (command) {
      case "connections_has_secret":
        return this.secrets.has(String(args?.id))
      case "connections_save": {
        if (this.failSave) throw { kind: "credential", message: "User canceled the operation." }
        const config = args?.config as ConnectionConfig
        if (typeof args?.secret === "string") this.secrets.set(config.id, args.secret)
        return config
      }
      case "mysql_connect":
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
async function answerPrompt(answer: PasswordAnswer | null): Promise<void> {
  for (let i = 0; i < 10 && usePasswordPrompt.getState().queue.length === 0; i++) await flush()
  const [request] = usePasswordPrompt.getState().queue
  expect(request?.config.id).toBe(MYSQL.id)
  usePasswordPrompt.getState().answer(request.id, answer)
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
