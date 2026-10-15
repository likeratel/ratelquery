import { forgetEditorState } from "../../components/editor/editorStateCache"
import { forgetTabColumnWidths } from "../../components/grid/useColumnWidths"
import type { AthenaConnectionConfig, ConnectionId } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import { isAppError } from "../../lib/ipc"
import { tabPendingCount, tabsForConnection, type QueryTab } from "../../lib/queryTabs"
import { statementAtCursor } from "../../lib/sqlContext"
import { dialectFor } from "../../lib/sqlDialect"
import { useAthenaStore } from "../../state/athenaStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { currentSettings } from "../../state/settingsStore"
import {
  selectActiveQueryTab,
  selectActiveTab,
  useTabsStore,
  type RunOutcome,
} from "../../state/tabsStore"
import { connectMysql } from "../connections/connectSession"
import { openDynamoTabFor } from "../dynamo/actions"
import { useDynamoCatalog } from "../dynamo/catalogStore"
import { editTargetFor } from "./editing"
import { editorFor } from "./editorRegistry"
import { confirmDangerousRun, planRun, useRunGuardStore } from "./runGuard"
import { forgetTabCountUps } from "./useCountUp"
import { showToast } from "../../components/ui"

/**
 * Opens a tab for any connection: a query tab for MySQL and Athena, a table browser for
 * DynamoDB. A failed MySQL connect rejects with the AppError; the caller reports it.
 */
export async function openConnection(connectionId: ConnectionId): Promise<void> {
  const config = useConnectionsStore.getState().byId(connectionId)
  if (config?.kind === "dynamodb") {
    openDynamoTabFor(connectionId)
    return
  }
  if (config?.kind === "athena") {
    openAthenaTab(config)
    return
  }
  await openMysqlTab(connectionId)
}

/**
 * Opens an Athena query tab on the connection's current database (the configured default the
 * first time) and starts listing its databases. Nothing runs until the user asks: every
 * statement is billed. Returns the tab id.
 */
export function openAthenaTab(config: AthenaConnectionConfig, database?: string | null): string {
  const athena = useAthenaStore.getState()
  const target =
    database !== undefined
      ? database
      : (athena.catalogs[config.id]?.currentDatabase ?? config.database ?? null)
  void athena.loadDatabases(config.id)
  if (target) void athena.setCurrentDatabase(config.id, target)
  return useTabsStore.getState().open(config.id, target, "athena")
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
 * rejects with the AppError (or `PASSWORD_CANCELLED`) and shows nothing, so the caller's report
 * is the only one.
 */
async function openMysqlTab(connectionId: ConnectionId): Promise<void> {
  // Asks for the password first when none is stored.
  const info = await connectMysql(connectionId)
  useTabsStore.getState().open(connectionId, info.currentDatabase)
}

/** Mod+T: a new tab of the active tab's kind, on its connection (and database for MySQL). */
export function newTabFromActive(): void {
  const active = selectActiveTab(useTabsStore.getState())
  if (!active) {
    showToast({ tone: "info", message: "Open a connection from the sidebar first" })
    return
  }
  if (active.kind === "dynamo") openDynamoTabFor(active.connectionId)
  else if (active.kind === "query") {
    useTabsStore.getState().open(active.connectionId, active.database, active.engine)
  } else useTabsStore.getState().open(active.connectionId, active.database)
}

/** Drops everything kept per tab outside the tabs store: editor state, badges, widths. */
function forgetTabState(id: string): void {
  forgetEditorState(id)
  useRunGuardStore.getState().forgetTab(id)
  forgetTabColumnWidths(id)
  forgetTabCountUps(id)
}

/**
 * Stops the Athena execution of a tab that is about to close, so it doesn't keep scanning (and
 * billing) with nobody to see the result. A failed stop is reported, not retried.
 */
function stopAthenaRun(id: string): void {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === id)
  if (tab?.kind !== "query" || tab.engine !== "athena" || !tab.running) return
  useTabsStore
    .getState()
    .cancel(id)
    .catch((raw: unknown) =>
      showToast({
        tone: "warning",
        message: "Couldn't stop the running Athena query",
        detail: isAppError(raw) ? raw.message : undefined,
      }),
    )
}

/**
 * Drops a tab and its cached state without asking. `stop` cancels its running Athena execution;
 * a deleted connection has no client left to cancel with.
 */
function removeTab(id: string, stop = true): void {
  if (stop) stopAthenaRun(id)
  useTabsStore.getState().close(id)
  forgetTabState(id)
}

/**
 * Closes a tab (Mod+W, middle click, the X). A tab with unsaved work stays open behind a
 * confirmation; `confirmCloseTab` finishes the close.
 */
export function closeQueryTab(id: string): void {
  const store = useTabsStore.getState()
  // Athena tabs never hold pending edits, so they close right away.
  stopAthenaRun(id)
  store.requestClose(id)
  if (useTabsStore.getState().closing !== id) forgetTabState(id)
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
  // The backend already dropped its client, so running Athena executions finish on AWS.
  for (const id of tabsForConnection(useTabsStore.getState(), connectionId)) removeTab(id, false)
  useSessionsStore.getState().forget(connectionId)
  useDynamoCatalog.getState().forget(connectionId)
  useAthenaStore.getState().forget(connectionId)
}

/**
 * An edited connection may point at another region, account or workgroup now. The backend
 * already stopped the executions of its old client when the config was saved, so the running
 * Athena tabs are only marked cancelled here (an `athena_cancel` would go through a client built
 * from the new settings): no later statement of the run starts, and the catalog is dropped.
 */
function connectionEdited(connectionId: ConnectionId): void {
  const tabs = useTabsStore.getState()
  for (const id of tabsForConnection(tabs, connectionId)) tabs.abandonRun(id)
  useAthenaStore.getState().forget(connectionId)
}

/**
 * Cleans up after deleted connections, and after edited ones (see `connectionEdited`).
 * Returns the unsubscribe function.
 */
export function subscribeConnectionCleanup(): () => void {
  const offRemoved = onAppEvent("connection-removed", forgetConnection)
  const offUpdated = onAppEvent("connection-updated", connectionEdited)
  return () => {
    offRemoved()
    offUpdated()
  }
}

/** Stops the active Athena tab's run (the Cancel button). */
export async function cancelActiveRun(): Promise<void> {
  const tab = selectActiveQueryTab(useTabsStore.getState())
  if (!tab || tab.engine !== "athena" || !tab.running) return
  try {
    await useTabsStore.getState().cancel(tab.id)
  } catch (raw) {
    showToast({
      tone: "error",
      message: "Couldn't cancel the query",
      detail: isAppError(raw) ? raw.message : undefined,
    })
  }
}

const OUTCOME_MESSAGES: Partial<Record<RunOutcome, string>> = {
  "pending-edits": "Apply or discard pending changes before running again",
  empty: "Nothing to run",
}

function reportOutcome(outcome: RunOutcome): void {
  const message = OUTCOME_MESSAGES[outcome]
  if (message) showToast({ tone: "info", message })
}

/** Mod+Enter runs the whole editor; Mod+Shift+Enter only the statement at the cursor. */
export async function runActiveTab(scope: "all" | "statement", cursor?: number): Promise<void> {
  const tab = selectActiveQueryTab(useTabsStore.getState())
  if (!tab) return
  if (scope === "all") {
    await runGuarded(tab, null)
    return
  }
  const head = cursor ?? editorFor(tab.id)?.state.selection.main.head ?? tab.sql.length
  const statement = statementAtCursor(tab.sql, head, dialectFor(tab.engine).syntax)
  if (!statement) {
    reportOutcome("empty")
    return
  }
  await runGuarded(tab, statement.text)
}

/**
 * Runs `sql` (the whole editor when null) after the query safety settings: destructive
 * statements wait for confirmation, and SELECTs without a LIMIT get the default one in the
 * executed text only. The editor text never changes.
 */
async function runGuarded(tab: QueryTab, sql: string | null): Promise<void> {
  // The store refuses these anyway; checking first avoids asking about a run that can't start.
  if (tab.running) return
  if (tabPendingCount(tab) > 0) {
    reportOutcome("pending-edits")
    return
  }
  const plan = planRun(sql ?? tab.sql, currentSettings().query, dialectFor(tab.engine))
  if (plan.dangers.length > 0) {
    const confirmed = await confirmDangerousRun(plan.dangers)
    // The tab may have closed while the dialog was open.
    if (!confirmed || !useTabsStore.getState().tabs.some((t) => t.id === tab.id)) return
  }
  const guard = useRunGuardStore.getState()
  const previous = guard.limitedByTab[tab.id] ?? []
  guard.setLimited(tab.id, plan.limited)
  const text = plan.changed ? plan.sql : (sql ?? undefined)
  const outcome = await useTabsStore.getState().run(tab.id, text)
  // A run that never started leaves the previous results, and their badges, on screen.
  if (outcome !== "ran" && outcome !== "failed") guard.setLimited(tab.id, previous)
  reportOutcome(outcome)
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
      showToast({
        tone: "success",
        message: `Applied changes · ${applied.affectedRows} ${rows} affected`,
      })
    }
  } catch (raw) {
    showToast({
      tone: "error",
      message: "Changes rolled back",
      detail: isAppError(raw) ? raw.message : "Couldn't apply changes",
    })
  }
}
