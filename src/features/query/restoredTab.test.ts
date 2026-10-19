import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useToastStore } from "../../components/ui/toastStore"
import { setTransport } from "../../lib/ipc"
import { INITIAL_TABS, createTab } from "../../lib/queryTabs"
import { useAthenaStore } from "../../state/athenaStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { emptySession, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { resetPasswordPrompt, usePasswordPrompt } from "../connections/passwordPrompt"
import { openAthenaTab, runActiveTab } from "./actions"
import { createAthenaSchemaRequests } from "./completion/athenaEnv"
import {
  createSwitcherOpener,
  ensureMysqlSession,
  isOpenIntent,
  type SessionOutcome,
} from "./mysqlSession"

let calls: string[] = []
let failConnect = false
let hasSecret = true
let restore: () => void = () => {}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits for the password prompt, then cancels it. */
async function cancelPrompt() {
  for (let i = 0; i < 10 && usePasswordPrompt.getState().queue.length === 0; i++) await flush()
  const [request] = usePasswordPrompt.getState().queue
  expect(request).toBeDefined()
  usePasswordPrompt.getState().answer(request.id, null)
  await flush()
}

beforeEach(() => {
  calls = []
  failConnect = false
  hasSecret = true
  resetPasswordPrompt()
  useToastStore.setState({ toasts: [] })
  restore = setTransport(async (command) => {
    calls.push(command)
    switch (command) {
      case "connections_has_secret":
        return hasSecret
      case "mysql_connect":
        if (failConnect) throw { kind: "connection", message: "Connection refused" }
        return { serverVersion: "8.4", currentDatabase: "app" }
      case "mysql_databases":
        return ["app"]
      case "mysql_schema":
        return { database: "app", tables: [], fetchedAt: "2026-01-01T00:00:00Z" }
      case "mysql_query":
        return []
      case "athena_databases":
        return ["sales"]
      case "athena_schema":
        return { database: "sales", tables: [], fetchedAt: "2026-01-01T00:00:00Z" }
      default:
        throw { kind: "not_found", message: command }
    }
  })
  useConnectionsStore.setState({
    connections: [
      { kind: "mysql", id: "m1", name: "A", host: "h", port: 3306, user: "u" },
      {
        kind: "athena",
        id: "a1",
        name: "Lake",
        region: "eu-west-1",
        auth: { type: "profile", profile: "p" },
      },
    ],
    status: "ready",
  })
  useSessionsStore.setState({ sessions: {} })
  useAthenaStore.setState({ catalogs: {} })
  // A tab reopened from the last run: no session behind it.
  const tab = { ...createTab("q1", "m1", "Query 1", "app"), sql: "select 1" }
  useTabsStore.setState({ ...INITIAL_TABS })
  useTabsStore.getState().restore([tab], "q1", 1)
})
afterEach(() => restore())

describe("a reopened MySQL tab", () => {
  it("connects on the first run, then runs", async () => {
    expect(calls).toEqual([])
    await runActiveTab("selection")
    expect(calls.indexOf("mysql_connect")).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf("mysql_connect")).toBeLessThan(calls.indexOf("mysql_query"))
    expect(useSessionsStore.getState().sessions.m1?.state).toBe("connected")
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ running: false, error: null })
  })

  it("doesn't run when the connect fails, and says so", async () => {
    failConnect = true
    await runActiveTab("selection")
    expect(calls).toContain("mysql_connect")
    expect(calls).not.toContain("mysql_query")
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ running: false, runId: 0 })
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it("doesn't run or toast when the password prompt is cancelled", async () => {
    hasSecret = false
    const run = runActiveTab("selection")
    await cancelPrompt()
    await run
    expect(calls).not.toContain("mysql_connect")
    expect(calls).not.toContain("mysql_query")
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it("reuses an open session and joins a connect in flight", async () => {
    const first = ensureMysqlSession("m1")
    // The stored-secret check runs first; then the session is connecting.
    for (let i = 0; i < 10 && !useSessionsStore.getState().sessions.m1; i++) await Promise.resolve()
    expect(useSessionsStore.getState().sessions.m1?.state).toBe("connecting")
    const joined = ensureMysqlSession("m1")
    expect(await Promise.all([first, joined])).toEqual(["ready", "ready"])
    expect(calls.filter((c) => c === "mysql_connect")).toHaveLength(1)
    calls = []
    expect(await ensureMysqlSession("m1")).toBe("ready")
    expect(calls).not.toContain("mysql_connect")
  })

  it("leaves an error-state session to the existing retry path", async () => {
    useSessionsStore.setState({ sessions: { m1: { ...emptySession(), state: "error" } } })
    expect(await ensureMysqlSession("m1")).toBe("ready")
    expect(calls).toEqual([])
  })
})

describe("the MySQL database picker of a reopened tab", () => {
  it("counts only a primary click or an opening key as intent", () => {
    expect(isOpenIntent({ type: "focus" })).toBe(false)
    expect(isOpenIntent({ type: "pointerdown", button: 0, timeStamp: 1 })).toBe(true)
    expect(isOpenIntent({ type: "pointerdown", button: 2, timeStamp: 1 })).toBe(false)
    for (const code of ["Enter", "NumpadEnter", "Space", "ArrowDown"]) {
      expect(isOpenIntent({ type: "keydown", code, timeStamp: 1 })).toBe(true)
    }
    expect(isOpenIntent({ type: "keydown", code: "Tab", timeStamp: 1 })).toBe(false)
  })

  it("doesn't ask again when focus comes back after a cancelled prompt", async () => {
    let now = 0
    let sessionOpen = false
    const asked: string[] = []
    const answers: ((outcome: SessionOutcome) => void)[] = []
    const open = createSwitcherOpener({
      needsSession: () => !sessionOpen,
      ensureSession: (id) => {
        asked.push(id)
        return new Promise((resolve) => answers.push(resolve))
      },
      now: () => now,
    })
    // Tabbing into the picker connects nothing.
    expect(open("m1", { type: "focus" })).toBe(false)
    expect(open("m1", { type: "keydown", code: "Tab", timeStamp: 1 })).toBe(false)
    // A click asks; a second press while the prompt is open doesn't stack another.
    expect(open("m1", { type: "pointerdown", button: 0, timeStamp: 2 })).toBe(true)
    expect(open("m1", { type: "keydown", code: "Enter", timeStamp: 3 })).toBe(false)
    // The user cancels; the dialog hands focus back to the picker.
    now = 10
    answers[0]("cancelled")
    await flush()
    expect(open("m1", { type: "focus" })).toBe(false)
    // A press queued before the prompt closed doesn't undo the cancel either.
    expect(open("m1", { type: "keydown", code: "Space", timeStamp: 9 })).toBe(false)
    expect(asked).toEqual(["m1"])
    // A new press asks again.
    expect(open("m1", { type: "keydown", code: "ArrowDown", timeStamp: 11 })).toBe(true)
    expect(asked).toEqual(["m1", "m1"])
    answers[1]("ready")
    await flush()
    sessionOpen = true
    expect(open("m1", { type: "pointerdown", button: 0, timeStamp: 20 })).toBe(false)
    expect(asked).toHaveLength(2)
  })
})

describe("a reopened Athena tab", () => {
  it("doesn't call AWS for completion until its catalog is touched", async () => {
    const request = createAthenaSchemaRequests(useAthenaStore)
    expect(request("a1", "sales")).toBeNull()
    await flush()
    expect(calls).toEqual([])
  })

  it("still loads schemas for a tab opened this run", async () => {
    openAthenaTab(
      {
        kind: "athena",
        id: "a1",
        name: "Lake",
        region: "eu-west-1",
        auth: { type: "profile", profile: "p" },
      },
      null,
    )
    await flush()
    const request = createAthenaSchemaRequests(useAthenaStore)
    await request("a1", "sales")
    expect(calls).toEqual(["athena_databases", "athena_schema"])
  })
})
