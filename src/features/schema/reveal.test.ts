import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { emptyAthenaCatalog } from "../../lib/athenaCatalog"
import { EMPTY_LAYOUT } from "../../lib/connectionLayout"
import type { ConnectionConfig } from "../../lib/connections"
import { selectTable, createDynamoTab } from "../../lib/dynamoTabs"
import { createTab, createTableTab, INITIAL_TABS } from "../../lib/queryTabs"
import { DEFAULT_SETTINGS } from "../../lib/settings"
import { useConnectionLayout } from "../../state/connectionLayoutStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { emptySession, useSessionsStore } from "../../state/sessionsStore"
import { useSettingsStore } from "../../state/settingsStore"
import { useTabsStore } from "../../state/tabsStore"
import type { AppError } from "../../lib/ipc"
import type { MysqlSessionState } from "../../lib/mysql"
import {
  goalFor,
  hidingFilters,
  loadStatus,
  markLoads,
  revealTarget,
  subscribeAutoReveal,
  type GoalContext,
  type RevealTarget,
} from "./reveal"
import {
  childKey,
  databaseKey,
  expandAll,
  failLoad,
  finishLoad,
  INITIAL_TREE,
  setFilter,
  startLoad,
  type TreeState,
} from "./treeState"
import { useSchemaTree } from "./treeStore"

const app = databaseKey("conn", "app")
const users = childKey(app, "users")
const sessions = { conn: { ...emptySession(), currentDatabase: "shop" } }
const catalogs = { conn: emptyAthenaCatalog("logs") }

const offline: AppError = { kind: "connection", message: "offline" }

const loaded = (state: TreeState, key: string): TreeState => {
  const started = startLoad(state, key)
  return finishLoad(started, key, started.loads[key].requestId, [])
}

const failed = (state: TreeState, key: string): TreeState => {
  const started = startLoad(state, key)
  return failLoad(started, key, started.loads[key].requestId, offline)
}

describe("revealTarget", () => {
  it("is null without an active tab", () => {
    expect(revealTarget(null, sessions, catalogs)).toBeNull()
  })

  it("reveals a table tab's table under its database", () => {
    const tab = createTableTab("t", "conn", "app", "users")
    expect(revealTarget(tab, sessions, catalogs)).toEqual({
      connectionId: "conn",
      expand: ["conn", app],
      row: users,
    })
  })

  it("reveals a query tab's own database, else the session's current one", () => {
    const own = createTab("q", "conn", "Query 1", "app")
    expect(revealTarget(own, sessions, catalogs)).toEqual({
      connectionId: "conn",
      expand: ["conn"],
      row: app,
    })
    const inherited = createTab("q", "conn", "Query 1", null)
    expect(revealTarget(inherited, sessions, catalogs)?.row).toBe(databaseKey("conn", "shop"))
  })

  it("reads an Athena tab's fallback database from its catalog", () => {
    const tab = createTab("q", "conn", "Query 1", null, "athena")
    expect(revealTarget(tab, sessions, catalogs)?.row).toBe(databaseKey("conn", "logs"))
  })

  it("reveals just the connection when a query tab has no database", () => {
    const tab = createTab("q", "conn", "Query 1", null)
    expect(revealTarget(tab, {}, {})).toEqual({ connectionId: "conn", expand: [], row: "conn" })
  })

  it("reveals a DynamoDB tab's table right under the connection", () => {
    const tab = createDynamoTab("d", "conn", "Scan")
    expect(revealTarget(tab, {}, {})).toEqual({ connectionId: "conn", expand: [], row: "conn" })
    expect(revealTarget(selectTable(tab, "orders"), {}, {})).toEqual({
      connectionId: "conn",
      expand: ["conn"],
      row: childKey("conn", "orders"),
    })
  })
})

const table: RevealTarget = { connectionId: "conn", expand: ["conn", app], row: users }
const connectionOnly: RevealTarget = { connectionId: "conn", expand: [], row: "conn" }
const databaseOnly: RevealTarget = { connectionId: "conn", expand: ["conn"], row: app }

describe("goalFor", () => {
  const context = (patch: Partial<GoalContext> = {}): GoalContext => ({
    focus: false,
    kind: "mysql",
    session: undefined,
    folded: false,
    tree: INITIAL_TREE,
    ...patch,
  })
  const live: MysqlSessionState[] = ["connected", "reconnecting", "connecting"]
  const notLive: (MysqlSessionState | undefined)[] = ["disconnected", "error", undefined]

  it.each(live)("reveals everything over a %s session", (session) => {
    expect(goalFor(table, context({ session }))).toBe(table)
  })

  it.each(notLive)("stops above the first load over a %s session", (session) => {
    expect(goalFor(table, context({ session }))).toEqual(connectionOnly)
    expect(goalFor(table, context({ session, tree: loaded(INITIAL_TREE, "conn") }))).toEqual(
      databaseOnly,
    )
    const both = loaded(loaded(INITIAL_TREE, "conn"), app)
    expect(goalFor(table, context({ session, tree: both }))).toBe(table)
  })

  it("stops above a failed load, which a remount would retry", () => {
    const tree = failed(loaded(INITIAL_TREE, "conn"), app)
    expect(goalFor(table, context({ session: "error", tree }))).toEqual(databaseOnly)
  })

  it("doesn't expand a node whose expanded descendants would load on mount", () => {
    // Collapsed connection, loaded, with a database left expanded whose tables never loaded.
    const tree = expandAll(loaded(INITIAL_TREE, "conn"), [app])
    expect(goalFor(databaseOnly, context({ session: "disconnected", tree }))).toEqual(
      connectionOnly,
    )
    // Already expanded, it is already mounted: nothing new mounts.
    const open = expandAll(tree, ["conn"])
    expect(goalFor(databaseOnly, context({ session: "disconnected", tree: open }))).toBe(
      databaseOnly,
    )
  })

  it("reveals nothing when opening the folders around it would mount a load", () => {
    const tree = expandAll(INITIAL_TREE, ["conn"])
    expect(goalFor(table, context({ folded: true, tree }))).toBeNull()
    expect(goalFor(table, context({ folded: true }))).toEqual(connectionOnly)
    expect(goalFor(table, context({ folded: false, tree }))).toEqual(connectionOnly)
  })

  it("lets the shortcut and other kinds go all the way, and skips unknown connections", () => {
    expect(goalFor(table, context({ focus: true }))).toBe(table)
    expect(goalFor(table, context({ focus: true, kind: undefined }))).toBe(table)
    expect(goalFor(table, context({ kind: "athena" }))).toBe(table)
    expect(goalFor(table, context({ kind: "dynamodb" }))).toBe(table)
    expect(goalFor(table, context({ kind: undefined }))).toBeNull()
  })
})

describe("hidingFilters", () => {
  it("names every node along the path whose filter hides the next one", () => {
    const tree = setFilter(setFilter(INITIAL_TREE, "conn", "shop"), app, "orders")
    expect(hidingFilters(table, tree)).toEqual(["conn", app])
    expect(hidingFilters(databaseOnly, tree)).toEqual(["conn"])
  })

  it("skips blank filters and ones that still show the next node", () => {
    expect(hidingFilters(table, INITIAL_TREE)).toEqual([])
    expect(hidingFilters(table, setFilter(INITIAL_TREE, app, "  "))).toEqual([])
    const showing = setFilter(setFilter(INITIAL_TREE, "conn", "AP"), app, "USE")
    expect(hidingFilters(table, showing)).toEqual([])
    expect(hidingFilters(connectionOnly, setFilter(INITIAL_TREE, "conn", "x"))).toEqual([])
  })
})

describe("loadStatus", () => {
  it("ignores a failure from before the reveal, which the remounted node retries", () => {
    const stale = failed(loaded(INITIAL_TREE, "conn"), app)
    const marks = markLoads(table, stale, undefined)
    expect(loadStatus(table, stale, undefined, marks)).toBe("settled")
    const retrying = startLoad(stale, app)
    expect(loadStatus(table, retrying, undefined, marks)).toBe("loading")
    const again = failed(stale, app)
    expect(loadStatus(table, again, undefined, marks)).toBe("failed")
  })

  it("counts the failure of a load that was already running when the reveal started", () => {
    const running = startLoad(loaded(INITIAL_TREE, "conn"), app)
    const marks = markLoads(table, running, undefined)
    expect(loadStatus(table, running, undefined, marks)).toBe("loading")
    const requestId = running.loads[app].requestId
    const broken = failLoad(running, app, requestId, offline)
    expect(loadStatus(table, broken, undefined, marks)).toBe("failed")
  })

  it("watches the DynamoDB table list only when the row sits under the connection", () => {
    const dynamoTable: RevealTarget = {
      connectionId: "conn",
      expand: ["conn"],
      row: childKey("conn", "orders"),
    }
    const clean = { loading: false, error: null }
    const marks = markLoads(dynamoTable, INITIAL_TREE, clean)
    expect(loadStatus(dynamoTable, INITIAL_TREE, { loading: true, error: null }, marks)).toBe(
      "loading",
    )
    const broken = { loading: false, error: offline }
    expect(loadStatus(dynamoTable, INITIAL_TREE, broken, marks)).toBe("failed")
    // An error already there when the reveal started may still be retried.
    const staleMarks = markLoads(dynamoTable, INITIAL_TREE, broken)
    expect(loadStatus(dynamoTable, INITIAL_TREE, broken, staleMarks)).toBe("settled")
    const connMarks = markLoads(connectionOnly, INITIAL_TREE, clean)
    expect(loadStatus(connectionOnly, INITIAL_TREE, broken, connMarks)).toBe("settled")
    // A list that was loading at the start and then failed is a fresh failure.
    const runningMarks = markLoads(dynamoTable, INITIAL_TREE, { loading: true, error: null })
    expect(loadStatus(dynamoTable, INITIAL_TREE, broken, runningMarks)).toBe("failed")
  })
})

describe("subscribeAutoReveal", () => {
  const mysql: ConnectionConfig = {
    kind: "mysql",
    id: "conn",
    name: "conn",
    host: "localhost",
    port: 3306,
    user: "root",
  }
  const revealed: RevealTarget[] = []
  let stop = () => {}

  const follow = () => {
    stop = subscribeAutoReveal((goal) => revealed.push(goal))
  }
  const setSession = (state: MysqlSessionState) =>
    useSessionsStore.setState({ sessions: { conn: { ...emptySession(), state } } })
  const enable = (revealActiveTab: boolean) =>
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, revealActiveTab } })

  beforeEach(() => {
    revealed.length = 0
    enable(true)
    useTabsStore.setState({ ...INITIAL_TABS })
    useSchemaTree.setState({ ...INITIAL_TREE })
    useConnectionLayout.setState({ layout: EMPTY_LAYOUT, status: "ready" })
    useConnectionsStore.setState({ connections: [mysql], status: "ready" })
    setSession("connected")
  })

  afterEach(() => stop())

  it("follows tab and database switches, and nothing else", () => {
    follow()
    const first = useTabsStore.getState().open("conn", "app")
    expect(revealed.map((g) => g.row)).toEqual([app])
    const second = useTabsStore.getState().open("conn", "app")
    expect(revealed).toHaveLength(2)
    useTabsStore.getState().setDatabase(second, "shop")
    expect(revealed.at(-1)?.row).toBe(databaseKey("conn", "shop"))
    useTabsStore.getState().activate(first)
    expect(revealed.at(-1)?.row).toBe(app)
    // A schema load or the editor text changes nothing the reveal depends on.
    useSessionsStore.setState((s) => ({
      sessions: { conn: { ...s.sessions.conn, schemaLoading: { app: true } } },
    }))
    useTabsStore.getState().setSql(first, "select 1")
    expect(revealed).toHaveLength(4)
  })

  it("does nothing while the setting is off and reveals once it is turned on", () => {
    enable(false)
    follow()
    useTabsStore.getState().open("conn", "app")
    expect(revealed).toEqual([])
    enable(true)
    expect(revealed.map((g) => g.row)).toEqual([app])
  })

  it("waits for the saved folder layout", () => {
    useConnectionLayout.setState({ status: "loading" })
    follow()
    useTabsStore.getState().open("conn", "app")
    expect(revealed).toEqual([])
    useConnectionLayout.setState({ status: "ready" })
    expect(revealed.map((g) => g.row)).toEqual([app])
  })

  it("waits for the connection list when it loads after the tabs", () => {
    useConnectionsStore.setState({ connections: [], status: "loading" })
    follow()
    useTabsStore.getState().open("conn", "app")
    expect(revealed).toEqual([])
    useConnectionsStore.setState({ connections: [mysql], status: "ready" })
    expect(revealed.map((g) => g.row)).toEqual([app])
  })

  it("reveals the rest once the session goes live", () => {
    setSession("disconnected")
    follow()
    useTabsStore.getState().open("conn", "app")
    expect(revealed.map((g) => g.row)).toEqual(["conn"])
    setSession("error")
    expect(revealed).toHaveLength(1)
    setSession("connected")
    expect(revealed.map((g) => g.row)).toEqual(["conn", app])
    setSession("connected")
    expect(revealed).toHaveLength(2)
  })
})
