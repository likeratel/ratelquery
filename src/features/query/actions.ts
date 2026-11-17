import { forgetEditorState } from "../../components/editor/editorStateCache"
import { forgetTabColumnWidths } from "../../components/grid/useColumnWidths"
import type { AthenaConnectionConfig, ConnectionId } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import {
  applyFailedTitle,
  appliedMessage,
  countChanges,
  needsApplyConfirm,
  staleApplyMessage,
  type ApplyStaleReason,
  type ChangeCounts,
} from "../../lib/applyPlan"
import { buildRowChanges, type EditTarget, type GridEdits } from "../../lib/gridEdits"
import { isAppError } from "../../lib/ipc"
import { mysqlApi, type DeletePlanEntry, type RowChange, type RowsResult } from "../../lib/mysql"
import {
  continueFailedMessage,
  mayDelete,
  stoppedMessage,
  unsupportedDeletes,
} from "../../lib/sqlTrash"
import { sqlInsertion } from "../../lib/queryOutput"
import {
  hasUnsavedWork,
  tabPendingCount,
  tabsForConnection,
  type QueryTab,
} from "../../lib/queryTabs"
import { runScopeText, type RunScope } from "../../lib/runScope"
import { dialectFor } from "../../lib/sqlDialect"
import { useAthenaStore } from "../../state/athenaStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useQueryOutputStore } from "../../state/queryOutputStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { currentSettings } from "../../state/settingsStore"
import { refreshTrash } from "../../state/trashStore"
import {
  selectActiveQueryTab,
  forgetBackupStop,
  releaseResume,
  selectActiveTab,
  takeBackupStop,
  useTabsStore,
  type RunOutcome,
} from "../../state/tabsStore"
import { connectMysql } from "../connections/connectSession"
import { openDynamoTabFor } from "../dynamo/actions"
import { useDynamoCatalog } from "../dynamo/catalogStore"
import { editTargetFor } from "./editing"
import { editorFor } from "./editorRegistry"
import { ensureMysqlSession } from "./mysqlSession"
import { confirmApply, confirmApplyWithoutBackup } from "./applyConfirm"
import { confirmStoppedDelete, confirmUnbackedDeletes } from "./deleteBackupConfirm"
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

/**
 * Drops everything kept per tab outside the tabs store: editor state, badges, widths, the
 * bottom panel choice. Its Output entries stay.
 */
function forgetTabState(id: string): void {
  forgetEditorState(id)
  useQueryOutputStore.getState().forgetTab(id)
  useRunGuardStore.getState().forgetTab(id)
  forgetBackupStop(id)
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

/**
 * Closes every tab of a connection (the X on its connection tab). When any of them holds unsaved
 * work, nothing closes until the user confirms once for the whole group (`closingGroup`);
 * `confirmCloseGroup` then closes them all.
 */
export function closeConnectionTabs(connectionId: ConnectionId): void {
  const store = useTabsStore.getState()
  const ids = tabsForConnection(store, connectionId)
  if (store.tabs.some((t) => t.connectionId === connectionId && hasUnsavedWork(t))) {
    store.requestCloseGroup(connectionId)
    return
  }
  for (const id of ids) removeTab(id)
}

/** Confirms closing the connection's tabs and throws their unsaved work away. */
export function confirmCloseGroup(): void {
  const store = useTabsStore.getState()
  const connectionId = store.closingGroup
  if (!connectionId) return
  store.cancelCloseGroup()
  for (const id of tabsForConnection(useTabsStore.getState(), connectionId)) removeTab(id)
}

export function cancelCloseGroup(): void {
  useTabsStore.getState().cancelCloseGroup()
}

export function closeActiveTab(): void {
  const active = selectActiveTab(useTabsStore.getState())
  if (active) closeQueryTab(active.id)
}

/** Closes every tab of the active tab's connection (Mod+Shift+W), asking first like the X. */
export function closeActiveConnection(): void {
  const active = selectActiveTab(useTabsStore.getState())
  if (active) closeConnectionTabs(active.connectionId)
}

/**
 * Closes every tab of a deleted connection and drops its session, table catalog and query
 * output (the saved file follows on the next output save).
 */
export function forgetConnection(connectionId: ConnectionId): void {
  // The connection is gone, so its tabs close without asking.
  // The backend already dropped its client, so running Athena executions finish on AWS.
  for (const id of tabsForConnection(useTabsStore.getState(), connectionId)) removeTab(id, false)
  useSessionsStore.getState().forget(connectionId)
  useDynamoCatalog.getState().forget(connectionId)
  useAthenaStore.getState().forget(connectionId)
  useQueryOutputStore.getState().forgetConnection(connectionId)
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

export interface RunContext {
  /** Cursor offset; read from the tab's editor when absent. */
  cursor?: number
  /** Selected editor text; read from the tab's editor when absent. */
  selectedText?: string
}

/** The editor's cursor and selection, for a run started outside the editor (buttons). */
function editorContext(tabId: string): RunContext {
  const state = editorFor(tabId)?.state
  if (!state) return {}
  const main = state.selection.main
  return { cursor: main.head, selectedText: state.sliceDoc(main.from, main.to) }
}

/**
 * Mod+Enter runs the statement at the cursor; Mod+Shift+Enter the selected text, or the whole
 * editor when nothing is selected.
 */
export async function runActiveTab(scope: RunScope, context: RunContext = {}): Promise<void> {
  const tab = selectActiveQueryTab(useTabsStore.getState())
  if (!tab) return
  const input = { sql: tab.sql, ...editorContext(tab.id), ...context }
  const text = runScopeText(scope, input, dialectFor(tab.engine).syntax)
  if (!text) {
    reportOutcome("empty")
    return
  }
  await runGuarded(tab, text.sql)
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
  // A reopened tab has no session yet; connect on the first run.
  if (tab.engine === "mysql" && (await ensureMysqlSession(tab.connectionId)) !== "ready") return
  if (!useTabsStore.getState().tabs.some((t) => t.id === tab.id)) return
  const plan = planRun(sql ?? tab.sql, currentSettings().query, dialectFor(tab.engine))
  if (plan.dangers.length > 0) {
    const confirmed = await confirmDangerousRun(plan.dangers)
    // The tab may have closed while the dialog was open.
    if (!confirmed || !useTabsStore.getState().tabs.some((t) => t.id === tab.id)) return
  }
  const text = plan.changed ? plan.sql : (sql ?? tab.sql)
  const skip = tab.engine === "mysql" ? await deletesToSkip(text) : []
  if (skip === null || !tabExists(tab.id)) return
  const guard = useRunGuardStore.getState()
  const previous = guard.limitedByTab[tab.id] ?? []
  guard.setLimited(tab.id, plan.limited)
  const outcome = await runWithBackupStops(tab.id, text, skip)
  // A run that never started leaves the previous results, and their badges, on screen.
  if (!RAN_OUTCOMES.has(outcome)) guard.setLimited(tab.id, previous)
  reportOutcome(outcome)
}

const RAN_OUTCOMES: ReadonlySet<RunOutcome> = new Set(["ran", "failed", "backup-stopped"])

const tabExists = (id: string) => useTabsStore.getState().tabs.some((t) => t.id === id)

/**
 * The statements of `text` whose DELETE may run without a trash backup: none when every DELETE
 * can be backed up, the unsupported ones when the user agrees, null (run nothing) when they
 * don't or the check failed.
 */
async function deletesToSkip(text: string): Promise<number[] | null> {
  if (!mayDelete(text)) return []
  let plan: DeletePlanEntry[]
  try {
    plan = await mysqlApi.deletePlan(text)
  } catch (raw) {
    showToast({
      tone: "error",
      message: "Couldn't check the DELETE statements, so nothing ran",
      detail: isAppError(raw) ? raw.message : undefined,
    })
    return null
  }
  const unsupported = unsupportedDeletes(plan)
  if (unsupported.length === 0) return []
  const confirmed = await confirmUnbackedDeletes(unsupported)
  return confirmed ? unsupported.map((entry) => entry.index) : null
}

/**
 * Reloads the Trash list when the tab's results include a DELETE that saved rows there, or when
 * a run with a DELETE failed (an interrupted COMMIT leaves an uncertain entry).
 */
function refreshAfterSqlDeletes(tabId: string, outcome: RunOutcome, text: string): void {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  if (tab?.kind !== "query") return
  const saved = tab.results.some((r) => r.kind === "exec" && (r.trashedRows ?? 0) > 0)
  if (saved || (outcome === "failed" && mayDelete(text))) refreshTrash()
}

/** A continued run failed; the results before it stay, and the error panel has the details. */
function reportContinueFailure(tabId: string, statementIndex: number): void {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  const detail = tab?.kind === "query" ? tab.error?.message : undefined
  showToast({ tone: "error", message: continueFailedMessage(statementIndex), detail })
}

/**
 * Runs `text`, and whenever a DELETE's backup fails at run time asks whether to go on without
 * one; only then the run continues from that statement (earlier ones never run again), its
 * results added to the tab's.
 */
async function runWithBackupStops(
  tabId: string,
  text: string,
  initialSkip: readonly number[],
): Promise<RunOutcome> {
  let skip = initialSkip
  const connectionId = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.connectionId
  let outcome = await useTabsStore.getState().run(tabId, text, { skipBackup: skip })
  refreshAfterSqlDeletes(tabId, outcome, text)
  while (outcome === "backup-stopped") {
    const stop = takeBackupStop(tabId)
    if (!stop) return outcome
    const go = await confirmStoppedDelete(stop)
    if (!go || !tabExists(tabId)) {
      // The kept connection isn't needed any more.
      if (connectionId) releaseResume(connectionId, stop)
      if (tabExists(tabId)) {
        showToast({ tone: "warning", message: stoppedMessage(stop.statementIndex) })
      }
      return outcome
    }
    skip = [...skip, stop.statementIndex]
    outcome = await useTabsStore.getState().run(tabId, text, {
      skipBackup: skip,
      startAt: stop.statementIndex,
      append: true,
      ...(stop.resumeToken ? { resumeToken: stop.resumeToken } : {}),
    })
    if (outcome === "failed") reportContinueFailure(tabId, stop.statementIndex)
    refreshAfterSqlDeletes(tabId, outcome, text)
  }
  return outcome
}

/**
 * Puts `sql` (from the Output log) into the tab's editor over the selection, on lines of its
 * own, and focuses the editor. Without a mounted editor it is appended to the tab's text.
 */
export function insertSqlIntoEditor(tabId: string, sql: string): void {
  const view = editorFor(tabId)
  if (view) {
    const { from, to } = view.state.selection.main
    const insert = sqlInsertion(view.state.doc.toString(), from, to, sql)
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    })
    view.focus()
    return
  }
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId)
  if (tab?.kind !== "query") return
  const end = tab.sql.length
  useTabsStore.getState().setSql(tabId, tab.sql + sqlInsertion(tab.sql, end, end, sql))
}

/** What one apply works on, captured when it started. */
interface ApplyJob {
  tabId: string
  connectionId: ConnectionId
  index: number
  target: EditTarget
  edits: GridEdits
  result: RowsResult
  changes: RowChange[]
  counts: ChangeCounts
}

/**
 * Why a dialog answer no longer applies: the tab, or the result the edits belong to, is gone
 * (`gone`), or its edits or rows changed or an apply is running (`changed`). Null when the tab
 * still holds exactly what the dialog showed.
 */
function staleReason(job: ApplyJob): ApplyStaleReason | null {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === job.tabId)
  if (tab?.kind !== "query" || !tab.results[job.index]) return "gone"
  const same =
    !tab.applying && tab.edits[job.index] === job.edits && tab.results[job.index] === job.result
  return same ? null : "changed"
}

/** True when the job may go ahead; otherwise says why nothing was applied. */
function stillCurrent(job: ApplyJob): boolean {
  const reason = staleReason(job)
  if (reason) showToast({ tone: "info", message: staleApplyMessage(reason) })
  return reason === null
}

/** The pending edits of the active result, or null when there is nothing to apply. */
function activeApplyJob(): ApplyJob | null {
  const tab = selectActiveQueryTab(useTabsStore.getState())
  // A held or repeated Mod+S must not send the same batch twice.
  if (!tab || tab.applying) return null
  const index = tab.activeResult
  const result = tab.results[index]
  const edits = tab.edits[index]
  const session = useSessionsStore.getState().sessions[tab.connectionId]
  const resolved = editTargetFor(tab, result, session)
  if (!resolved.editable || !edits || result?.kind !== "rows") return null
  const changes = buildRowChanges(edits, resolved.target, result.rows)
  if (changes.length === 0) return null
  const { connectionId } = tab
  const counts = countChanges(changes)
  return {
    tabId: tab.id,
    connectionId,
    index,
    target: resolved.target,
    edits,
    result,
    changes,
    counts,
  }
}

const tableLabel = (target: EditTarget) => `${target.database}.${target.table}`

/**
 * Sends the job's edits. When the trash refuses the backup (`backup_failed`), asks whether to
 * delete without one and, only on yes, sends the same edits again with `skipBackup`.
 */
async function sendApply(job: ApplyJob, skipBackup: boolean): Promise<void> {
  try {
    const options = skipBackup ? { skipBackup: true } : {}
    const applied = await useTabsStore
      .getState()
      .applyEdits(job.tabId, job.index, job.target, options)
    if (applied) {
      if (job.counts.deletes > 0 && !skipBackup) refreshTrash()
      showToast({
        tone: "success",
        message: appliedMessage(
          applied.affectedRows,
          job.counts.deletes,
          skipBackup ? "skipped" : "kept",
        ),
      })
    }
  } catch (raw) {
    if (!skipBackup && isAppError(raw) && raw.kind === "backup_failed") {
      const go = await confirmApplyWithoutBackup({
        table: tableLabel(job.target),
        message: raw.message,
        deletes: job.counts.deletes,
      })
      if (!go) return
      if (!stillCurrent(job)) return
      await sendApply(job, true)
      return
    }
    // A failed delete can leave an uncertain entry (interrupted COMMIT, MyISAM).
    if (job.counts.deletes > 0 && !skipBackup) refreshTrash()
    const kind = isAppError(raw) ? raw.kind : "unknown"
    showToast({
      tone: "error",
      message: applyFailedTitle(kind),
      detail: isAppError(raw) ? raw.message : "Couldn't apply changes",
    })
  }
}

/**
 * Mod+S and the Apply button: apply the active result's pending edits. Updates and deletes wait
 * for a confirmation that shows the SQL to run (inserts alone apply right away); the answer only
 * counts while the edits are unchanged.
 */
export async function applyActiveEdits(): Promise<void> {
  const job = activeApplyJob()
  if (!job) return
  if (needsApplyConfirm(job.counts)) {
    const { target, changes } = job
    const confirmed = await confirmApply(
      {
        table: tableLabel(target),
        counts: job.counts,
        retentionDays: currentSettings().query.trashRetentionDays,
      },
      () => mysqlApi.previewChanges(job.connectionId, target.database, target.table, changes),
    )
    if (!confirmed) return
    if (!stillCurrent(job)) return
  }
  await sendApply(job, false)
}
