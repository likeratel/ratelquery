import { forgetEditorState } from "../../components/editor/SqlEditor"
import type { ConnectionId } from "../../lib/connections"
import { isAppError } from "../../lib/ipc"
import { statementAtCursor } from "../../lib/sqlContext"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { selectActiveTab, useTabsStore, type RunOutcome } from "../../state/tabsStore"
import { editTargetFor } from "./editing"
import { editorFor } from "./editorRegistry"
import { toast } from "./toastStore"

/**
 * Connects (if needed) and opens a query tab for the given MySQL connection. A failed connect
 * shows a toast and rejects with the AppError, so callers may also react to it.
 */
export async function openQueryTabFor(connectionId: ConnectionId): Promise<void> {
  const config = useConnectionsStore.getState().byId(connectionId)
  const fallback = config?.kind === "mysql" ? (config.database ?? null) : null
  try {
    const info = await useSessionsStore.getState().connect(connectionId, fallback)
    useTabsStore.getState().open(connectionId, info.currentDatabase)
  } catch (raw) {
    const name = config?.name ?? "the server"
    toast(
      `Couldn't connect to ${name}: ${isAppError(raw) ? raw.message : "unknown error"}`,
      "danger",
    )
    throw raw
  }
}

/** Mod+T: a new tab on the active tab's connection and database. */
export function newTabFromActive(): void {
  const active = selectActiveTab(useTabsStore.getState())
  if (!active) {
    toast("Open a connection from the sidebar first")
    return
  }
  useTabsStore.getState().open(active.connectionId, active.database)
}

export function closeQueryTab(id: string): void {
  useTabsStore.getState().close(id)
  forgetEditorState(id)
}

export function closeActiveTab(): void {
  const active = selectActiveTab(useTabsStore.getState())
  if (active) closeQueryTab(active.id)
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
  const tab = selectActiveTab(useTabsStore.getState())
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
  const tab = selectActiveTab(useTabsStore.getState())
  if (!tab) return
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
