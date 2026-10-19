import { describe, expect, it } from "vitest"
import type { ConnectionConfig } from "./connections"
import { createDynamoTab } from "./dynamoTabs"
import { createTab, finishRun, INITIAL_TABS, type TabsState } from "./queryTabs"
import {
  diffWorkspace,
  maxQuerySeq,
  mergeRestoredTabs,
  normalizeWorkspace,
  restoreTabs,
  serializeWorkspace,
  type Workspace,
  type WorkspaceTab,
} from "./workspace"

const connections: ConnectionConfig[] = [
  { kind: "mysql", id: "m1", name: "A", host: "h", port: 3306, user: "u" },
  {
    kind: "athena",
    id: "a1",
    name: "Lake",
    region: "eu-west-1",
    auth: { type: "profile", profile: "p" },
  },
  {
    kind: "dynamodb",
    id: "d1",
    name: "D",
    region: "us-east-1",
    auth: { type: "profile", profile: "p" },
  },
]
const byId = (id: string) => connections.find((c) => c.id === id)

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

const workspace = (tabs: WorkspaceTab[], activeTabId: string | null = null): Workspace => ({
  version: 1,
  activeTabId,
  tabs,
})

describe("serializeWorkspace", () => {
  it("keeps query tabs only, without results or run state", () => {
    const ran = finishRun(
      { ...createTab("q1", "m1", "Query 1", "app"), sql: "select 1" },
      "select 1",
      [],
    )
    const athena = { ...createTab("q2", "a1", "Query 2", null, "athena"), running: true }
    const state: TabsState = {
      ...INITIAL_TABS,
      tabs: [ran, createDynamoTab("d", "d1", "DynamoDB 3"), athena],
      activeId: "q2",
      seq: 3,
    }
    expect(serializeWorkspace(state)).toEqual({
      version: 1,
      activeTabId: "q2",
      tabs: [
        saved("q1"),
        saved("q2", {
          connectionId: "a1",
          engine: "athena",
          title: "Query 2",
          sql: "",
          database: null,
        }),
      ],
    })
  })

  it("saves no active tab when a non-query tab is active", () => {
    const state: TabsState = {
      ...INITIAL_TABS,
      tabs: [createTab("q1", "m1", "Query 1", null), createDynamoTab("d", "d1", "DynamoDB 2")],
      activeId: "d",
    }
    expect(serializeWorkspace(state).activeTabId).toBeNull()
  })
})

describe("restoreTabs", () => {
  it("reopens tabs as fresh ones with their SQL, database and active tab", () => {
    const result = restoreTabs(
      workspace(
        [saved("q1"), saved("q2", { connectionId: "a1", engine: "athena", title: "Query 7" })],
        "q2",
      ),
      byId,
    )
    expect(result.activeId).toBe("q2")
    expect(result.seq).toBe(7)
    expect(result.tabs[0]).toEqual({ ...createTab("q1", "m1", "Query 1", "app"), sql: "select 1" })
    expect(result.tabs[1]).toMatchObject({
      engine: "athena",
      results: [],
      running: false,
      executionId: null,
    })
  })

  it("drops tabs of deleted connections or of a connection of another kind", () => {
    const result = restoreTabs(
      workspace(
        [
          saved("gone", { connectionId: "deleted" }),
          saved("q1", { title: "Query 2" }),
          saved("wrong", { connectionId: "d1" }),
          saved("mismatch", { connectionId: "a1" }),
        ],
        "gone",
      ),
      byId,
    )
    expect(result.tabs.map((t) => t.id)).toEqual(["q1"])
    expect(result.activeId).toBe("q1")
    expect(result.seq).toBe(2)
  })

  it("restores nothing from an empty workspace", () => {
    expect(restoreTabs(workspace([], "x"), byId)).toEqual({ tabs: [], activeId: null, seq: 0 })
  })
})

describe("maxQuerySeq", () => {
  it("reads only exact 'Query N' titles", () => {
    expect(maxQuerySeq(["Query 3", "Query 12", "users", "Query x", "My Query 40"])).toBe(12)
    expect(maxQuerySeq([])).toBe(0)
  })
})

describe("mergeRestoredTabs", () => {
  it("puts restored tabs first and keeps a tab opened meanwhile active", () => {
    const open = createTab("new", "m1", "Query 1", null)
    const state: TabsState = { ...INITIAL_TABS, tabs: [open], activeId: "new", seq: 1 }
    const restored = restoreTabs(workspace([saved("q1", { title: "Query 4" })], "q1"), byId)
    const next = mergeRestoredTabs(state, restored)
    expect(next.tabs.map((t) => t.id)).toEqual(["q1", "new"])
    expect(next.activeId).toBe("new")
    expect(next.seq).toBe(4)
    expect(state.tabs).toHaveLength(1)
  })

  it("activates the restored tab when nothing was open", () => {
    const restored = restoreTabs(workspace([saved("q1"), saved("q2")], "q2"), byId)
    expect(mergeRestoredTabs(INITIAL_TABS, restored).activeId).toBe("q2")
  })
})

describe("diffWorkspace", () => {
  const base = workspace([saved("q1"), saved("q2")], "q1")
  it("tells text edits from tab changes", () => {
    expect(diffWorkspace(base, base)).toBe("none")
    expect(diffWorkspace(base, workspace([saved("q1", { sql: "x" }), saved("q2")], "q1"))).toBe(
      "sql",
    )
    for (const next of [
      workspace([saved("q1"), saved("q2")], "q2"),
      workspace([saved("q1")], "q1"),
      workspace([saved("q2"), saved("q1")], "q1"),
      workspace([saved("q1", { database: "shop", sql: "x" }), saved("q2")], "q1"),
      workspace([saved("q1", { title: "Renamed" }), saved("q2")], "q1"),
    ]) {
      expect(diffWorkspace(base, next)).toBe("structure")
    }
  })
})

describe("normalizeWorkspace", () => {
  it("accepts version 1 and drops tabs that don't parse", () => {
    expect(
      normalizeWorkspace({
        version: 1,
        activeTabId: "q1",
        tabs: [saved("q1"), { ...saved("q2"), engine: "postgres" }, { id: 3 }],
      }),
    ).toEqual(workspace([saved("q1")], "q1"))
  })

  it("is null for anything else", () => {
    for (const raw of [
      null,
      undefined,
      "x",
      [],
      { version: 2, activeTabId: null, tabs: [] },
      { version: 1 },
    ]) {
      expect(normalizeWorkspace(raw)).toBeNull()
    }
  })
})
