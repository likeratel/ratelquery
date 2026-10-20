import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionConfig } from "../lib/connections"
import { INITIAL_TABS } from "../lib/queryTabs"
import type { Workspace, WorkspaceTab } from "../lib/workspace"
import { useConnectionsStore } from "./connectionsStore"
import { useTabsStore } from "./tabsStore"
import { createCloseRegistry, createWorkspaceSync, type WorkspaceSync } from "./workspaceSync"

const connections: ConnectionConfig[] = [
  { kind: "mysql", id: "m1", name: "A", host: "h", port: 3306, user: "u" },
  {
    kind: "athena",
    id: "a1",
    name: "Lake",
    region: "eu-west-1",
    auth: { type: "profile", profile: "p" },
  },
]

const saved = (id: string, patch: Partial<WorkspaceTab> = {}): WorkspaceTab => ({
  id,
  kind: "query",
  connectionId: "m1",
  engine: "mysql",
  title: "Query 1",
  sql: "select 1",
  database: "app",
  ...patch,
})

/** Fake backend file: `load` returns what was saved last. */
class FakeFile {
  stored: Workspace | null = null
  saves: Workspace[] = []
  warnings: string[] = []
  failSave = false
  failLoad = false

  load = async () => {
    if (this.failLoad) throw { kind: "io", message: "denied" }
    return this.stored
  }
  save = async (workspace: Workspace) => {
    if (this.failSave) throw { kind: "io", message: "disk full" }
    this.saves.push(workspace)
    this.stored = workspace
  }
  warn = (message: string) => {
    this.warnings.push(message)
  }
}

let file: FakeFile
let sync: WorkspaceSync
let stop: () => void = () => {}
/** What the sync registered to run before the window closes. */
let beforeClose: (() => Promise<void>) | null = null

/** Lets queued microtasks and resolved promises run. */
const onClose = (handler: () => Promise<void>) => {
  beforeClose = handler
  return () => {
    beforeClose = null
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

const setConnectionsReady = () => useConnectionsStore.setState({ connections, status: "ready" })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  file = new FakeFile()
  sync = createWorkspaceSync({
    load: () => file.load(),
    save: (workspace) => file.save(workspace),
    warn: file.warn,
    sqlDelayMs: 1000,
    onClose,
  })
  useTabsStore.setState({ ...INITIAL_TABS })
  useConnectionsStore.setState({ connections: [], status: "idle" })
})

afterEach(() => {
  stop()
  stop = () => {}
  vi.useRealTimers()
})

const startRestored = async (stored: Workspace | null = null) => {
  file.stored = stored
  setConnectionsReady()
  stop = sync.start()
  await settle()
  file.saves = []
}

describe("restoring", () => {
  it("waits for the connection list and never saves the startup state", async () => {
    file.stored = {
      version: 1,
      activeTabId: "q2",
      tabs: [saved("q1"), saved("q2", { title: "Query 5" })],
    }
    stop = sync.start()
    useTabsStore.getState().setSql("missing", "x")
    await vi.advanceTimersByTimeAsync(2000)
    expect(file.saves).toEqual([])
    expect(useTabsStore.getState().tabs).toEqual([])

    setConnectionsReady()
    await settle()
    const state = useTabsStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(["q1", "q2"])
    expect(state.activeId).toBe("q2")
    expect(state.seq).toBe(5)
    expect(file.saves).toEqual([])
    // The next tab continues the numbering.
    useTabsStore.getState().open("m1", null)
    expect(useTabsStore.getState().tabs[2].title).toBe("Query 6")
  })

  it("drops tabs of deleted connections and saves the smaller workspace", async () => {
    await startRestored({
      version: 1,
      activeTabId: "gone",
      tabs: [saved("gone", { connectionId: "deleted" }), saved("q1")],
    })
    expect(useTabsStore.getState().activeId).toBe("q1")
    // `startRestored` cleared the saves; check the file itself.
    expect(file.stored).toEqual({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
  })

  it("keeps tabs opened while loading and restores only once", async () => {
    file.stored = { version: 1, activeTabId: "q1", tabs: [saved("q1")] }
    stop = sync.start()
    const early = useTabsStore.getState().open("m1", null)
    setConnectionsReady()
    useConnectionsStore.setState({ status: "ready" })
    await settle()
    const state = useTabsStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(["q1", early])
    expect(state.activeId).toBe(early)
    expect(file.saves).toHaveLength(1)
    await sync.restore(() => undefined)
    expect(useTabsStore.getState().tabs).toHaveLength(2)
  })

  it("turns saving off when the load fails", async () => {
    file.failLoad = true
    setConnectionsReady()
    stop = sync.start()
    await settle()
    useTabsStore.getState().open("m1", null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(file.saves).toEqual([])
    expect(file.warnings).toEqual(["Couldn't load the saved tabs"])
  })
})

describe("saving", () => {
  it("saves tab changes in the same task once, right away", async () => {
    await startRestored()
    const tabs = useTabsStore.getState()
    const first = tabs.open("m1", "app")
    tabs.open("a1", null, "athena")
    tabs.activate(first)
    await settle()
    expect(file.saves).toHaveLength(1)
    expect(file.saves[0].activeTabId).toBe(first)
    expect(file.saves[0].tabs.map((t) => t.engine)).toEqual(["mysql", "athena"])
  })

  it("debounces editor text and saves the latest", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
    const tabs = useTabsStore.getState()
    tabs.setSql("q1", "s")
    await vi.advanceTimersByTimeAsync(600)
    tabs.setSql("q1", "se")
    await vi.advanceTimersByTimeAsync(999)
    expect(file.saves).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(file.saves.map((w) => w.tabs[0].sql)).toEqual(["se"])
  })

  it("saves a database change at once, with pending text", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
    useTabsStore.getState().setSql("q1", "typed")
    useTabsStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === "q1" ? { ...t, database: "shop" } : t)),
    }))
    await settle()
    expect(file.saves).toHaveLength(1)
    expect(file.saves[0].tabs[0]).toMatchObject({ sql: "typed", database: "shop" })
    await vi.advanceTimersByTimeAsync(2000)
    expect(file.saves).toHaveLength(1)
  })

  it("ignores result and run updates", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
    useTabsStore.getState().setActiveResult("q1", 2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(file.saves).toEqual([])
  })

  it("saves closing a tab, which is how a deleted connection's tabs go", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1"), saved("q2")] })
    useTabsStore.getState().close("q1")
    await settle()
    expect(file.saves).toEqual([{ version: 1, activeTabId: "q2", tabs: [saved("q2")] }])
  })

  it("warns once per failure streak", async () => {
    await startRestored()
    file.failSave = true
    useTabsStore.getState().open("m1", null)
    await settle()
    useTabsStore.getState().open("m1", null)
    await settle()
    expect(file.warnings).toEqual(["Couldn't save the open tabs"])
    file.failSave = false
    useTabsStore.getState().open("m1", null)
    await settle()
    expect(file.saves[0].tabs).toHaveLength(3)
  })

  it("writes pending text when stopped", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
    useTabsStore.getState().setSql("q1", "last words")
    stop()
    stop = () => {}
    await settle()
    expect(file.saves.map((w) => w.tabs[0].sql)).toEqual(["last words"])
  })

  it("writes pending text before the window closes, and waits for it", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
    useTabsStore.getState().setSql("q1", "closing")
    let done = false
    const closing = beforeClose?.().then(() => {
      done = true
    })
    await settle()
    await closing
    expect(done).toBe(true)
    expect(file.saves.map((w) => w.tabs[0].sql)).toEqual(["closing"])
    stop()
    stop = () => {}
    expect(beforeClose).toBeNull()
  })

  it("doesn't hold the window when the save hangs", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
    file.save = () => new Promise<void>(() => {})
    useTabsStore.getState().setSql("q1", "stuck")
    let done = false
    void beforeClose?.().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(1499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it("never runs two saves at once", async () => {
    await startRestored({ version: 1, activeTabId: "q1", tabs: [saved("q1")] })
    let running = 0
    let most = 0
    const original = file.save
    file.save = async (workspace) => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 50))
      running -= 1
      await original(workspace)
    }
    useTabsStore.getState().open("m1", null)
    await settle()
    useTabsStore.getState().open("m1", null)
    await settle()
    useTabsStore.getState().open("m1", null)
    await vi.advanceTimersByTimeAsync(500)
    expect(most).toBe(1)
    expect(file.saves.at(-1)?.tabs).toHaveLength(4)
  })
})

describe("createCloseRegistry", () => {
  it("runs every registered callback from one listener and waits for all of them", async () => {
    const listener: { runAll?: () => Promise<void> } = {}
    let attached = 0
    let detached = 0
    const register = createCloseRegistry((run) => {
      attached += 1
      listener.runAll = run
      return () => (detached += 1)
    })
    const done: string[] = []
    let releaseSlow: () => void = () => {}
    const offFast = register(async () => {
      done.push("fast")
    })
    const offSlow = register(
      () =>
        new Promise<void>((resolve) => {
          releaseSlow = () => {
            done.push("slow")
            resolve()
          }
        }),
    )
    expect(attached).toBe(1)
    let closed = false
    const closing = listener.runAll?.().then(() => {
      closed = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toEqual(["fast"])
    expect(closed).toBe(false)
    releaseSlow()
    await closing
    expect(done).toEqual(["fast", "slow"])

    offFast()
    expect(detached).toBe(0)
    offSlow()
    offSlow()
    expect(detached).toBe(1)
    register(async () => {})
    expect(attached).toBe(2)
  })
})
