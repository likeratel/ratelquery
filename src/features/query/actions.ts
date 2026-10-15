import { forgetEditorState } from "../../components/editor/editorStateCache"
import type { ConnectionId } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import { isAppError } from "../../lib/ipc"
import { tabsForConnection } from "../../lib/queryTabs"
import { statementAtCursor } from "../../lib/sqlContext"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import {
  selectActiveQueryTab,
  selectActiveTab,
  useTabsStore,
  type RunOutcome,
} from "../../state/tabsStore"
import { openDynamoTabFor } from "../dynamo/actions"
import { useDynamoCatalog } from "../dynamo/catalogStore"
import { editTargetFor } from "./editing"
import { editorFor } from "./editorRegistry"
import { toast } from "./toastStore"

/**
 * Opens a tab for any connection: a query tab for MySQL, a table browser for DynamoDB.
 * A failed MySQL connect rejects with the AppError; the caller reports it.
 */
export async function openConnection(connectionId: ConnectionId): Promise<void> {
  const config = useConnectionsStore.getState().byId(connectionId)
  if (config?.kind === "dynamodb") {
    openDynamoTabFor(connectionId)
    return
  }
  await openMysqlTab(connectionId)
}

/**
 * Kept for existing callers (the connection list). Routes through `openConnection`, so a
 * DynamoDB connection opens its table browser instead of a SQL tab.
 */
export function openQueryTabFor(connectionId: ConnectionId): Promise<void> {
  return openConnection(connectionId)
}

/**
 * Connects (if needed) and opens a query tab for the given MySQL connection. A failed connect
 * rejects with the AppError and shows nothing, so the caller's report is the only one.
 */
async function openMysqlTab(connectionId: ConnectionId): Promise<void> {
  const config = useConnectionsStore.getState().byId(connectionId)
  const fallback = config?.kind === "mysql" ? (config.database ?? null) : null
  const info = await useSessionsStore.getState().connect(connectionId, fallback)
  useTabsStore.getState().open(connectionId, info.currentDatabase)
}

/** Mod+T: a new tab of the active tab's kind, on its connection (and database for MySQL). */
export function newTabFromActive(): void {
  const active = selectActiveTab(useTabsStore.getState())
  if (!active) {
    toast("Open a connection from the sidebar first")
    return
  }
  if (active.kind === "dynamo") openDynamoTabFor(active.connectionId)
  else useTabsStore.getState().open(active.connectionId, active.database)
}

/** Drops a tab and its cached editor state without asking. */
function removeTab(id: string): void {
  useTabsStore.getState().close(id)
  forgetEditorState(id)
}

/**
 * Closes a tab (Mod+W, middle click, the X). A tab with unsaved work stays open behind a
 * confirmation; `confirmCloseTab` finishes the close.
 */
export function closeQueryTab(id: string): void {
  const store = useTabsStore.getState()
  store.requestClose(id)
  if (useTabsStore.getState().closing !== id) forgetEditorState(id)
}

/** Confirms the pending close and throws the unsaved work away. */
export function confirmCloseTab(): void {
  const id = useTabsStore.getState().closing
  if (id) removeTab(id)
}

export function cancelCloseTab(): void {
  useTabsStore.getState().cancelClose()
}

export function closeActiveTab(): void {
  const active = selectActiveTab(useTabsStore.getState())
  if (active) closeQueryTab(active.id)
}

/** Closes every tab of a deleted connection and drops its session and table catalog. */
export function forgetConnection(connectionId: ConnectionId): void {
  // The connection is gone, so its tabs close without asking.
  for (const id of tabsForConnection(useTabsStore.getState(), connectionId)) removeTab(id)
  useSessionsStore.getState().forget(connectionId)
  useDynamoCatalog.getState().forget(connectionId)
}

/** Cleans up after deleted connections. Returns the unsubscribe function. */
export function subscribeConnectionCleanup(): () => void {
  return onAppEvent("connection-removed", forgetConnection)
}

const OUTCOME_MESSAGES: Partial<Record<RunOutcome, string>> = {
  "pending-edits": "Apply or discard pending changes before running again",
  empty: "Nothing to run",
}

function reportOutcome(outcome: RunOutcome): void {
  const message = OUTCOME_MESSAGES[outcome]
  if (message) toast(message)
}

/** Mod+Enter runs the whole editor; Mod+Shift+Enter only the statement at the cursor. */
export async function runActiveTab(scope: "all" | "statement", cursor?: number): Promise<void> {
  const tab = selectActiveQueryTab(useTabsStore.getState())
  if (!tab) return
  if (scope === "all") {
    reportOutcome(await useTabsStore.getState().run(tab.id))
    return
  }
  const head = cursor ?? editorFor(tab.id)?.state.selection.main.head ?? tab.sql.length
  const statement = statementAtCursor(tab.sql, head)
  if (!statement) {
    reportOutcome("empty")
    return
  }
  reportOutcome(await useTabsStore.getState().run(tab.id, statement.text))
}

/** Mod+S: apply the active result's pending edits. */
export async function applyActiveEdits(): Promise<void> {
  const tab = selectActiveQueryTab(useTabsStore.getState())
  // A held or repeated Mod+S must not send the same batch twice.
  if (!tab || tab.applying) return
  const index = tab.activeResult
  const session = useSessionsStore.getState().sessions[tab.connectionId]
  const resolved = editTargetFor(tab, tab.results[index], session)
  if (!resolved.editable || !tab.edits[index]) return
  try {
    const applied = await useTabsStore.getState().applyEdits(tab.id, index, resolved.target)
    if (applied) {
      const rows = applied.affectedRows === 1 ? "row" : "rows"
      toast(`Applied changes · ${applied.affectedRows} ${rows} affected`, "success")
    }
  } catch (raw) {
    const message = isAppError(raw) ? raw.message : "Couldn't apply changes"
    toast(`Changes rolled back: ${message}`, "danger")
  }
}
