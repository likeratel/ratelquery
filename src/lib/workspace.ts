import { z } from "zod"
import type { ConnectionConfig, ConnectionId } from "./connections"
import { ipc } from "./ipc"
import { createTab, type QueryEngine, type QueryTab, type TabsState } from "./queryTabs"

/** One open query tab as saved in `workspace.json`: what it is, not what it last showed. */
export interface WorkspaceTab {
  id: string
  kind: "query"
  connectionId: ConnectionId
  engine: QueryEngine
  title: string
  sql: string
  database: string | null
}

/** The query tabs open when the app last ran (`workspace_load` / `workspace_save`). */
export interface Workspace {
  version: 1
  activeTabId: string | null
  tabs: readonly WorkspaceTab[]
}

export const EMPTY_WORKSPACE: Workspace = { version: 1, activeTabId: null, tabs: [] }

const tabSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("query"),
  connectionId: z.string().min(1),
  engine: z.enum(["mysql", "athena"]),
  title: z.string(),
  sql: z.string(),
  database: z.string().nullable(),
})

/**
 * Reads the IPC response, which is not trusted: anything but a version 1 workspace is null, and
 * tabs that don't parse are dropped.
 */
export function normalizeWorkspace(raw: unknown): Workspace | null {
  const shape = z
    .object({
      version: z.literal(1),
      activeTabId: z.string().nullable().catch(null),
      tabs: z.array(z.unknown()),
    })
    .safeParse(raw)
  if (!shape.success) return null
  const tabs = shape.data.tabs.flatMap((tab) => {
    const parsed = tabSchema.safeParse(tab)
    return parsed.success ? [parsed.data] : []
  })
  return { version: 1, activeTabId: shape.data.activeTabId, tabs }
}

export const workspaceApi = {
  /** Null when nothing was saved or the file was unusable. */
  load: async () => normalizeWorkspace(await ipc<unknown>("workspace_load")),
  save: (workspace: Workspace) => ipc<void>("workspace_save", { workspace }),
}

/**
 * What to save for the current tabs: the query tabs only, without results, edits or run state.
 * The active tab is kept when it is a query tab.
 */
export function serializeWorkspace(state: Pick<TabsState, "tabs" | "activeId">): Workspace {
  const tabs = state.tabs.flatMap((tab): WorkspaceTab[] =>
    tab.kind === "query"
      ? [
          {
            id: tab.id,
            kind: "query",
            connectionId: tab.connectionId,
            engine: tab.engine,
            title: tab.title,
            sql: tab.sql,
            database: tab.database,
          },
        ]
      : [],
  )
  const activeTabId = tabs.some((t) => t.id === state.activeId) ? state.activeId : null
  return { version: 1, activeTabId, tabs }
}

/**
 * How two workspaces differ: `structure` when tabs were opened, closed, reordered, renamed,
 * switched or moved to another database; `sql` when only editor text changed.
 */
export type WorkspaceChange = "none" | "sql" | "structure"

export function diffWorkspace(a: Workspace, b: Workspace): WorkspaceChange {
  if (a.activeTabId !== b.activeTabId || a.tabs.length !== b.tabs.length) return "structure"
  let sqlChanged = false
  for (let i = 0; i < a.tabs.length; i += 1) {
    const x = a.tabs[i]
    const y = b.tabs[i]
    if (
      x.id !== y.id ||
      x.connectionId !== y.connectionId ||
      x.engine !== y.engine ||
      x.title !== y.title ||
      x.database !== y.database
    ) {
      return "structure"
    }
    if (x.sql !== y.sql) sqlChanged = true
  }
  return sqlChanged ? "sql" : "none"
}

export interface RestoredTabs {
  tabs: readonly QueryTab[]
  activeId: string | null
  /** Next "Query N" counter: the highest N among the restored titles. */
  seq: number
}

const QUERY_TITLE = /^Query (\d+)$/

/** Highest N of the "Query N" titles, or 0. */
export function maxQuerySeq(titles: readonly string[]): number {
  return titles.reduce((max, title) => {
    const n = QUERY_TITLE.exec(title)?.[1]
    return n ? Math.max(max, Number(n)) : max
  }, 0)
}

/**
 * Query tabs to reopen from a saved workspace. Tabs whose connection no longer exists, or is
 * of another kind now than the tab's engine, are left out. When the saved active tab is gone
 * the first tab becomes active. Each tab starts like a freshly opened one (no results, nothing
 * running), keeping its SQL and database.
 */
export function restoreTabs(
  workspace: Workspace,
  byId: (id: ConnectionId) => ConnectionConfig | undefined,
): RestoredTabs {
  const tabs = workspace.tabs
    .filter((saved) => byId(saved.connectionId)?.kind === saved.engine)
    .map((saved) => ({
      ...createTab(saved.id, saved.connectionId, saved.title, saved.database, saved.engine),
      sql: saved.sql,
    }))
  const active = tabs.find((t) => t.id === workspace.activeTabId) ?? tabs[0] ?? null
  return {
    tabs,
    activeId: active?.id ?? null,
    seq: maxQuerySeq(tabs.map((t) => t.title)),
  }
}

/**
 * Puts restored tabs in front of the tabs opened while the workspace was loading. Those keep
 * their place and stay active; ids already open are not added twice. The counter never goes
 * back.
 */
export function mergeRestoredTabs(state: TabsState, restored: RestoredTabs): TabsState {
  const open = new Set(state.tabs.map((t) => t.id))
  const added = restored.tabs.filter((t) => !open.has(t.id))
  return {
    ...state,
    tabs: [...added, ...state.tabs],
    activeId: state.activeId ?? restored.activeId,
    seq: Math.max(state.seq, restored.seq),
  }
}
