import type { ConnectionId } from "../../lib/connections"
import { dynamoApi, type Item, type KeySchema, type Page } from "../../lib/dynamo"
import {
  diffItems,
  itemKey,
  putExpectation,
  sameKey,
  validateKeyAttributes,
} from "../../lib/dynamoDiff"
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
  isEditorDirty,
  nextStartKeys,
  openEditor,
  selectItem,
  selectTable,
  setForm,
  startDynamoRun,
  updateEditor,
  type DynamoTab,
  type ItemEditorState,
  type ItemView,
  type PageMove,
} from "../../lib/dynamoTabs"
import { isAppError, normalizeError } from "../../lib/ipc"
import { selectActiveDynamoTab, useTabsStore } from "../../state/tabsStore"
import { toast } from "../query/toastStore"
import { descriptionFor, useDynamoCatalog } from "./catalogStore"

const tabs = () => useTabsStore.getState()

function findTab(id: string): DynamoTab | null {
  const tab = tabs().tabs.find((t) => t.id === id)
  return tab?.kind === "dynamo" ? tab : null
}

const patch = (id: string, update: (tab: DynamoTab) => DynamoTab) => tabs().updateDynamo(id, update)

const messageOf = (raw: unknown, fallback: string) => (isAppError(raw) ? raw.message : fallback)

/** Opens a DynamoDB tab for the connection and starts listing its tables. */
export function openDynamoTabFor(connectionId: ConnectionId): string {
  const id = tabs().openDynamo(connectionId)
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
  if (!tab.table) {
    toast("Choose a table first")
    return null
  }
  let request = tab.request
  if (move === "first") {
    const built = buildDynamoRequest({
      table: tab.table,
      mode: tab.mode,
      form: tab.form,
      description: descriptionFor(tab.connectionId, tab.table),
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

export function reviewActiveEdit(): void {
  const tab = selectActiveDynamoTab(tabs())
  if (tab?.editor) reviewEdit(tab.id)
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

/** Re-reads the current page and selects the item with `key`, when given. */
async function refreshAndSelect(tabId: string, key: Item | null, schema: KeySchema) {
  const tab = findTab(tabId)
  if (!tab) return
  const page = await runDynamo(tabId, tab.request ? "current" : "first")
  if (!page || !key) return
  const index = page.items.findIndex((item) => sameKey(item, key, schema))
  if (index !== -1) selectRow(tabId, index)
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
  toast(editor.original && expect === "exists" ? "Saved item" : "Created item", "success")
  await refreshAndSelect(tabId, itemKey(item, schema), schema)
}

/** Deletes an item by its table key, then refreshes the page. Returns true on success. */
export async function deleteItem(tabId: string, item: Item): Promise<boolean> {
  const tab = findTab(tabId)
  const schema = tab ? tableKeySchema(tab) : null
  const key = schema ? itemKey(item, schema) : null
  if (!tab?.table || !schema) return false
  if (!key) {
    toast("This item has no complete key, so it can't be deleted", "danger")
    return false
  }
  try {
    await dynamoApi.deleteItem(tab.connectionId, tab.table, key)
  } catch (raw) {
    toast(`Delete failed: ${messageOf(raw, "unknown error")}`, "danger")
    return false
  }
  toast("Deleted item", "success")
  await refreshAndSelect(tabId, null, schema)
  return true
}
