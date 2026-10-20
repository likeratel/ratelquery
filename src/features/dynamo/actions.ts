import type { ConnectionId } from "../../lib/connections"
import { dynamoApi, type Item, type KeySchema, type Page } from "../../lib/dynamo"
import {
  diffItems,
  itemKey,
  putExpectation,
  sameKey,
  validateKeyAttributes,
} from "../../lib/dynamoDiff"
import {
  buildItemUpdates,
  EMPTY_DYNAMO_EDITS,
  itemEdit,
  keyId,
  keyLabel,
  stageCellEdit,
  withoutItems,
} from "../../lib/dynamoEdits"
import { findLossyAttributes, formatItem, parseItem, type JsonMode } from "../../lib/dynamoJson"
import {
  buildDynamoRequest,
  withStartKey,
  type DynamoForm,
  type DynamoMode,
} from "../../lib/dynamoRequest"
import {
  closeEditor,
  failDynamoRun,
  finishDynamoRun,
  guardDiscard,
  hasPendingEdits,
  isEditorDirty,
  nextStartKeys,
  openEditor,
  selectedItem,
  selectItem,
  selectTable,
  setForm,
  showDetail,
  startDynamoRun,
  updateEditor,
  type DynamoTab,
  type ItemEditorState,
  type ItemView,
  type PageMove,
} from "../../lib/dynamoTabs"
import { isAppError, normalizeError } from "../../lib/ipc"
import { currentSettings } from "../../state/settingsStore"
import { selectActiveDynamoTab, useTabsStore } from "../../state/tabsStore"
import { showToast } from "../../components/ui"
import { descriptionFor, useDynamoCatalog } from "./catalogStore"

const tabs = () => useTabsStore.getState()

function findTab(id: string): DynamoTab | null {
  const tab = tabs().tabs.find((t) => t.id === id)
  return tab?.kind === "dynamo" ? tab : null
}

const patch = (id: string, update: (tab: DynamoTab) => DynamoTab) => tabs().updateDynamo(id, update)

const messageOf = (raw: unknown, fallback: string) => (isAppError(raw) ? raw.message : fallback)

/** Like the SQL grid: pending edits block anything that would replace the page under them. */
function refusePendingEdits(tab: DynamoTab, action: string): boolean {
  if (!hasPendingEdits(tab)) return false
  showToast({ tone: "info", message: `Apply or discard pending changes before ${action}` })
  return true
}

/** Opens a DynamoDB tab for the connection and starts listing its tables. */
export function openDynamoTabFor(connectionId: ConnectionId): string {
  const id = tabs().openDynamo(connectionId)
  // New tabs start with the configured page size; switching tables keeps whatever the tab has.
  patch(id, (t) => setForm(t, { limit: String(currentSettings().dynamo.pageSize) }))
  void useDynamoCatalog.getState().loadTables(connectionId)
  return id
}

/**
 * Picks a table, loads its key schema and shows its first page. With unsaved editor changes it
 * asks "Discard changes?" first and switches only once the user confirms.
 */
export async function chooseTable(tabId: string, table: string): Promise<void> {
  const tab = findTab(tabId)
  if (!tab || tab.table === table) return
  if (refusePendingEdits(tab, "switching tables")) return
  const guarded = guardDiscard(tab, { kind: "table", table })
  if (guarded) {
    patch(tabId, () => guarded)
    return
  }
  await switchTable(tabId, table)
}

async function switchTable(tabId: string, table: string): Promise<void> {
  const tab = findTab(tabId)
  if (!tab || tab.table === table) return
  patch(tabId, (t) => selectTable(t, table))
  await useDynamoCatalog.getState().describe(tab.connectionId, table)
  const current = findTab(tabId)
  if (current?.table === table && current.mode === "scan") await runDynamo(tabId, "first")
}

export function setDynamoMode(tabId: string, mode: DynamoMode): void {
  patch(tabId, (t) => ({ ...t, mode }))
}

export function patchForm(tabId: string, update: Partial<DynamoForm>): void {
  patch(tabId, (t) => setForm(t, update))
}

export function setItemView(tabId: string, view: ItemView): void {
  patch(tabId, (t) => ({ ...t, view }))
}

export function selectRow(tabId: string, index: number | null): void {
  patch(tabId, (t) => selectItem(t, index))
}

async function fetchPage(tab: DynamoTab, request: DynamoTab["request"], startKey: Item | null) {
  if (!request) throw new Error("No request")
  const next = withStartKey(request, startKey)
  return "scan" in next
    ? dynamoApi.scan(tab.connectionId, next.scan)
    : dynamoApi.query(tab.connectionId, next.query)
}

/**
 * Runs the form (`first`) or moves through the pages of the last request. Returns the page, or
 * null when nothing ran or the request failed (the error is then on the tab).
 */
export async function runDynamo(tabId: string, move: PageMove = "first"): Promise<Page | null> {
  const tab = findTab(tabId)
  if (!tab || tab.running) return null
  // Re-reading the current page keeps the edits (they are keyed by item), as after Apply.
  if (move !== "current" && refusePendingEdits(tab, "running again")) return null
  if (!tab.table) {
    showToast({ tone: "info", message: "Choose a table first" })
    return null
  }
  let request = tab.request
  if (move === "first") {
    const built = buildDynamoRequest({
      table: tab.table,
      mode: tab.mode,
      form: tab.form,
      description: descriptionFor(tab.connectionId, tab.table),
      defaultLimit: currentSettings().dynamo.pageSize,
    })
    if (!built.ok) {
      patch(tabId, (t) => failDynamoRun(t, { kind: "invalid_input", message: built.error }))
      return null
    }
    request = built.value
  }
  const startKeys = nextStartKeys(tab, move)
  if (!request || !startKeys) return null
  patch(tabId, startDynamoRun)
  const runId = tab.runId
  const isCurrent = (t: DynamoTab) => t.runId === runId
  try {
    const page = await fetchPage(tab, request, startKeys.at(-1) ?? null)
    patch(tabId, (t) => (isCurrent(t) ? finishDynamoRun(t, request, startKeys, page) : t))
    return page
  } catch (raw) {
    const error = normalizeError(raw)
    patch(tabId, (t) => (isCurrent(t) ? failDynamoRun(t, error) : t))
    return null
  }
}

/** Mod+Enter in a DynamoDB tab. */
export function runActiveDynamo(): void {
  const tab = selectActiveDynamoTab(tabs())
  if (tab) void runDynamo(tab.id, "first")
}

function tableKeySchema(tab: DynamoTab): KeySchema | null {
  return descriptionFor(tab.connectionId, tab.table)?.keySchema ?? null
}

/** A new item seeded with empty key attributes of the right types. */
function keyTemplate(schema: KeySchema | null): Item {
  if (!schema) return {}
  const attrs = schema.range ? [schema.hash, schema.range] : [schema.hash]
  return Object.fromEntries(
    attrs.map((a) => [a.name, a.type === "N" ? { N: "0" } : { [a.type]: "" }]),
  )
}

/**
 * Opens the editor for an existing item, or for a new one when `item` is null. With unsaved
 * editor changes it asks "Discard changes?" first and opens only once the user confirms.
 */
export function openItemEditor(tabId: string, item: Item | null): void {
  const tab = findTab(tabId)
  if (!tab?.table || tab.editor?.saving) return
  if (item && itemEdit(tab.edits, item, tableKeySchema(tab))) {
    showToast({
      tone: "info",
      message: "Apply or discard this item's pending changes before editing it as JSON",
    })
    return
  }
  const guarded = guardDiscard(tab, { kind: "open", item })
  if (guarded) {
    patch(tabId, () => guarded)
    return
  }
  replaceEditor(tabId, item)
}

function replaceEditor(tabId: string, item: Item | null): void {
  const tab = findTab(tabId)
  if (!tab?.table) return
  const schema = tableKeySchema(tab)
  const seed = item ?? keyTemplate(schema)
  const binaryKey = schema?.hash.type === "B" || schema?.range?.type === "B"
  const mode: JsonMode = findLossyAttributes(seed).length > 0 || binaryKey ? "wire" : "plain"
  patch(tabId, (t) => openEditor(t, item, mode, seed))
}

export function setEditorText(tabId: string, text: string): void {
  patch(tabId, (t) =>
    t.editor?.stage === "edit"
      ? updateEditor(t, { text, error: null, pending: null, discard: null })
      : t,
  )
}

/** Re-formats the editor text in the other mode. Refuses plain mode when it would lose data. */
export function switchEditorMode(tabId: string, mode: JsonMode): void {
  const editor = findTab(tabId)?.editor
  if (!editor || editor.mode === mode || editor.stage !== "edit") return
  const parsed = parseItem(editor.text, editor.mode)
  if (!parsed.ok) {
    patch(tabId, (t) =>
      updateEditor(t, { error: `Fix the JSON before switching: ${parsed.error}` }),
    )
    return
  }
  const lossy = mode === "plain" ? findLossyAttributes(parsed.value) : []
  if (lossy.length > 0) {
    const reason = `${lossy[0].path}: ${lossy[0].reason}`
    patch(tabId, (t) => updateEditor(t, { error: `Plain mode would change data. ${reason}` }))
    return
  }
  const text = formatItem(parsed.value, mode)
  patch(tabId, (t) =>
    updateEditor(t, { mode, text, initialText: reformatInitial(editor, mode, text), error: null }),
  )
}

/**
 * The editor's starting text in the new mode, so the dirty marker compares like with like.
 * A clean editor stays clean; an unparseable start (never expected) keeps the old text.
 */
function reformatInitial(editor: ItemEditorState, mode: JsonMode, text: string): string {
  if (!isEditorDirty(editor)) return text
  const initial = parseItem(editor.initialText, editor.mode)
  return initial.ok ? formatItem(initial.value, mode) : editor.initialText
}

/** Mod+S: validates the editor text and moves to the diff confirmation. */
export function reviewEdit(tabId: string): void {
  const tab = findTab(tabId)
  const editor = tab?.editor
  if (!tab || !editor || editor.stage !== "edit") return
  const fail = (error: string) => patch(tabId, (t) => updateEditor(t, { error }))
  const schema = tableKeySchema(tab)
  if (!schema) return fail("Table details are still loading; try again in a moment")
  const parsed = parseItem(editor.text, editor.mode)
  if (!parsed.ok) return fail(parsed.error)
  const keyError = validateKeyAttributes(parsed.value, schema)
  if (keyError) return fail(keyError)
  if (editor.original && diffItems(editor.original, parsed.value).length === 0) {
    return fail("Nothing changed")
  }
  patch(tabId, (t) =>
    updateEditor(t, { stage: "confirm", pending: parsed.value, error: null, discard: null }),
  )
}

/** Mod+S in a DynamoDB tab: reviews the open item editor, otherwise applies grid edits. */
export function reviewActiveEdit(): void {
  const tab = selectActiveDynamoTab(tabs())
  if (tab?.editor) reviewEdit(tab.id)
  else if (tab && hasPendingEdits(tab)) void applyDynamoEdits(tab.id)
}

export function backToEdit(tabId: string): void {
  patch(tabId, (t) => updateEditor(t, { stage: "edit", pending: null, error: null }))
}

/** Closes the editor, asking "Discard changes?" first when it holds unsaved text. */
export function closeItemEditor(tabId: string): void {
  const tab = findTab(tabId)
  if (!tab?.editor || tab.editor.saving) return
  patch(tabId, (t) => guardDiscard(t, { kind: "close" }) ?? closeEditor(t))
}

/** Hides the "Discard changes?" prompt and keeps the text. */
export function keepEditing(tabId: string): void {
  patch(tabId, (t) => updateEditor(t, { discard: null }))
}

/** Confirms the prompt: drops the editor, then does what the user asked for. */
export async function discardEditorChanges(tabId: string): Promise<void> {
  const intent = findTab(tabId)?.editor?.discard
  if (!intent) return
  patch(tabId, closeEditor)
  if (intent.kind === "table") await switchTable(tabId, intent.table)
  else if (intent.kind === "open") replaceEditor(tabId, intent.item)
}

/**
 * Esc: dismisses the discard prompt, steps back from the confirmation, otherwise closes the
 * editor (which asks first when there are unsaved changes).
 */
export function escapeEditor(tabId: string): void {
  const editor = findTab(tabId)?.editor
  if (!editor || editor.saving) return
  if (editor.discard) keepEditing(tabId)
  else if (editor.stage === "confirm") backToEdit(tabId)
  else closeItemEditor(tabId)
}

/**
 * Re-reads the current page and selects the item with `key`, when given. Before any request
 * ran there is no page to re-read (and the form may not even be valid yet, as in Query mode),
 * so the item is fetched on its own and shown in the side panel instead.
 */
async function refreshAndSelect(tabId: string, key: Item | null, schema: KeySchema) {
  const tab = findTab(tabId)
  if (!tab) return
  if (!tab.request) {
    if (key) await showFetchedItem(tabId, key)
    return
  }
  const page = await runDynamo(tabId, "current")
  if (!page || !key) return
  const index = page.items.findIndex((item) => sameKey(item, key, schema))
  if (index !== -1) selectRow(tabId, index)
}

/** Reads one item by key and shows it in the side panel, unless the tab moved on meanwhile. */
async function showFetchedItem(tabId: string, key: Item): Promise<void> {
  const tab = findTab(tabId)
  if (!tab?.table) return
  const { table, runId } = tab
  try {
    const item = await dynamoApi.getItem(tab.connectionId, table, key)
    if (item)
      patch(tabId, (t) => (t.table === table && t.runId === runId ? showDetail(t, item) : t))
  } catch (raw) {
    showToast({
      tone: "warning",
      message: "Couldn't load the saved item",
      detail: messageOf(raw, "unknown error"),
    })
  }
}

/** Writes the confirmed item with a safe-write condition, then refreshes the page. */
export async function confirmSave(tabId: string): Promise<void> {
  const tab = findTab(tabId)
  const editor = tab?.editor
  const schema = tab ? tableKeySchema(tab) : null
  if (!tab?.table || !editor?.pending || editor.saving || !schema) return
  const item = editor.pending
  const expect = putExpectation(editor.original, item, schema)
  patch(tabId, (t) => updateEditor(t, { saving: true, error: null }))
  try {
    await dynamoApi.putItem(tab.connectionId, tab.table, item, expect)
  } catch (raw) {
    const message = messageOf(raw, "unknown error")
    const hint =
      expect === "not_exists"
        ? "An item with this key may already exist."
        : "The item may have been deleted."
    patch(tabId, (t) => updateEditor(t, { saving: false, error: `${message} ${hint}` }))
    return
  }
  patch(tabId, closeEditor)
  showToast({
    tone: "success",
    message: editor.original && expect === "exists" ? "Saved item" : "Created item",
  })
  await refreshAndSelect(tabId, itemKey(item, schema), schema)
}

/** Deletes an item by its table key, then refreshes the page. Returns true on success. */
export async function deleteItem(tabId: string, item: Item): Promise<boolean> {
  const tab = findTab(tabId)
  const schema = tab ? tableKeySchema(tab) : null
  const key = schema ? itemKey(item, schema) : null
  if (!tab?.table || !schema) return false
  if (!key) {
    showToast({ tone: "error", message: "This item has no complete key, so it can't be deleted" })
    return false
  }
  try {
    await dynamoApi.deleteItem(tab.connectionId, tab.table, key)
  } catch (raw) {
    showToast({ tone: "error", message: "Delete failed", detail: messageOf(raw, "unknown error") })
    return false
  }
  showToast({ tone: "success", message: "Deleted item" })
  patch(tabId, (t) => ({
    ...t,
    detail: t.detail && sameKey(t.detail, key, schema) ? null : t.detail,
    // Edits of a deleted item can only fail now.
    edits: withoutItems(t.edits, [keyId(key)]),
  }))
  await refreshAndSelect(tabId, null, schema)
  return true
}

/**
 * Stages a typed cell value of the page item at `index`. Returns an error message to keep the
 * cell editor open, or null once the edit is pending.
 */
export function commitCellEdit(
  tabId: string,
  index: number,
  name: string,
  text: string,
): string | null {
  const tab = findTab(tabId)
  const item = tab?.page?.items[index]
  const schema = tab ? tableKeySchema(tab) : null
  if (!tab || !item) return "This item is no longer on the page"
  if (!schema) return "Table details are still loading; try again in a moment"
  if (tab.applying) return "Changes are being applied"
  const original = tab.editor?.original
  if (original && sameKey(original, item, schema)) return "Close the item editor first"
  const staged = stageCellEdit(tab.edits, { item, schema, name, text })
  if (!staged.ok) return staged.error
  patch(tabId, (t) => ({ ...t, edits: staged.value }))
  return null
}

export function discardDynamoEdits(tabId: string): void {
  patch(tabId, (t) => (t.applying ? t : { ...t, edits: EMPTY_DYNAMO_EDITS }))
}

const MAX_LISTED_FAILURES = 3

function failureDetail(failures: readonly { key: Item; message: string }[]): string {
  const listed = failures
    .slice(0, MAX_LISTED_FAILURES)
    .map((f) => `${keyLabel(f.key)}: ${f.message}`)
  const more = failures.length - listed.length
  return more > 0 ? `${listed.join("; ")}; and ${more} more` : listed.join("; ")
}

/**
 * Writes the pending grid edits, one conditional UpdateItem per item. Items that were written
 * leave the pending list; failed ones stay pending and are reported. Then the page is re-read.
 */
export async function applyDynamoEdits(tabId: string): Promise<void> {
  const tab = findTab(tabId)
  const schema = tab ? tableKeySchema(tab) : null
  if (!tab?.table || !schema || tab.applying || tab.running) return
  const updates = buildItemUpdates(tab.edits)
  if (updates.length === 0) return
  const { connectionId, table } = tab
  patch(tabId, (t) => ({ ...t, applying: true }))
  const written: string[] = []
  const failures: { key: Item; message: string }[] = []
  for (const update of updates) {
    try {
      await dynamoApi.updateItemAttributes(connectionId, table, update.key, update.changes)
      written.push(update.id)
    } catch (raw) {
      failures.push({ key: update.key, message: messageOf(raw, "unknown error") })
    }
  }
  patch(tabId, (t) => ({ ...t, applying: false, edits: withoutItems(t.edits, written) }))
  const noun = (n: number) => (n === 1 ? "item" : "items")
  if (failures.length === 0) {
    showToast({
      tone: "success",
      message: `Applied changes · ${written.length} ${noun(written.length)} updated`,
    })
  } else {
    showToast({
      tone: "error",
      message:
        written.length > 0
          ? `Updated ${written.length} of ${updates.length} items; ${failures.length} still pending`
          : `Couldn't update ${failures.length} ${noun(failures.length)}; changes are still pending`,
      detail: failureDetail(failures),
    })
  }
  const current = findTab(tabId)
  const selected = current ? selectedItem(current) : null
  await refreshAndSelect(tabId, selected ? itemKey(selected, schema) : null, schema)
}
