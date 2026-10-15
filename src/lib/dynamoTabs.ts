import type { ConnectionId } from "./connections"
import type { DynamoExportRequest, Item, Page } from "./dynamo"
import { formatItem, type JsonMode } from "./dynamoJson"
import { EMPTY_FORM, type DynamoForm, type DynamoMode } from "./dynamoRequest"
import type { AppError } from "./ipc"

export type ItemView = "table" | "json"

/** What the user asked for while the editor had unsaved changes, awaiting "Discard changes?". */
export type DiscardIntent = { kind: "close" } | { kind: "table"; table: string }

export interface ItemEditorState {
  /** Item being edited; null for a new item. */
  original: Item | null
  mode: JsonMode
  text: string
  /** Text when the editor opened or last switched mode; drives the dirty marker. */
  initialText: string
  /** `confirm` shows the attribute diff before writing. */
  stage: "edit" | "confirm"
  /** Parsed item awaiting confirmation. */
  pending: Item | null
  error: string | null
  saving: boolean
  /** Set while the inline "Discard changes?" prompt is showing. */
  discard: DiscardIntent | null
}

export interface DynamoTab {
  kind: "dynamo"
  id: string
  connectionId: ConnectionId
  title: string
  table: string | null
  mode: DynamoMode
  form: DynamoForm
  /** Request behind the current page, without a start key. Next / previous / refresh reuse it. */
  request: DynamoExportRequest | null
  /** Start key of every page visited so far; the last entry produced `page`. */
  startKeys: readonly (Item | null)[]
  page: Page | null
  running: boolean
  error: AppError | null
  /** Index into `page.items`. */
  selected: number | null
  view: ItemView
  editor: ItemEditorState | null
  /** Increments on every finished request; drives stale-response checks and count-up. */
  runId: number
  lastElapsedMs: number | null
}

export type PageMove = "first" | "next" | "previous" | "current"

export function createDynamoTab(id: string, connectionId: ConnectionId, title: string): DynamoTab {
  return {
    kind: "dynamo",
    id,
    connectionId,
    title,
    table: null,
    mode: "scan",
    form: EMPTY_FORM,
    request: null,
    startKeys: [],
    page: null,
    running: false,
    error: null,
    selected: null,
    view: "table",
    editor: null,
    runId: 0,
    lastElapsedMs: null,
  }
}

/** Switches the tab to another table, clearing everything tied to the previous one. */
export function selectTable(tab: DynamoTab, table: string): DynamoTab {
  if (tab.table === table) return tab
  return {
    ...createDynamoTab(tab.id, tab.connectionId, table),
    table,
    mode: tab.mode,
    // Keys, index and expressions belong to the old table; the page size carries over.
    form: { ...EMPTY_FORM, limit: tab.form.limit },
    view: tab.view,
    runId: tab.runId + 1,
    lastElapsedMs: tab.lastElapsedMs,
  }
}

export function setForm(tab: DynamoTab, patch: Partial<DynamoForm>): DynamoTab {
  return { ...tab, form: { ...tab.form, ...patch } }
}

/** The start-key stack after a page move, or null when the move isn't possible. */
export function nextStartKeys(tab: DynamoTab, move: PageMove): readonly (Item | null)[] | null {
  switch (move) {
    case "first":
      return [null]
    case "next":
      return tab.page?.lastKey ? [...tab.startKeys, tab.page.lastKey] : null
    case "previous":
      return tab.startKeys.length > 1 ? tab.startKeys.slice(0, -1) : null
    case "current":
      return tab.startKeys.length > 0 ? tab.startKeys : null
  }
}

export function canGoNext(tab: DynamoTab): boolean {
  return !tab.running && Boolean(tab.page?.lastKey)
}

export function canGoPrevious(tab: DynamoTab): boolean {
  return !tab.running && tab.startKeys.length > 1
}

/** 1-based page number of the current page; 0 before the first run. */
export function pageNumber(tab: DynamoTab): number {
  return tab.startKeys.length
}

export function startDynamoRun(tab: DynamoTab): DynamoTab {
  return { ...tab, running: true, error: null }
}

export function finishDynamoRun(
  tab: DynamoTab,
  request: DynamoExportRequest,
  startKeys: readonly (Item | null)[],
  page: Page,
): DynamoTab {
  return {
    ...tab,
    running: false,
    error: null,
    request,
    startKeys,
    page,
    selected: null,
    runId: tab.runId + 1,
    lastElapsedMs: page.elapsedMs,
  }
}

/** Keeps the previous page and paging state; only the error is shown. */
export function failDynamoRun(tab: DynamoTab, error: AppError): DynamoTab {
  return { ...tab, running: false, error, runId: tab.runId + 1 }
}

export function selectItem(tab: DynamoTab, index: number | null): DynamoTab {
  const count = tab.page?.items.length ?? 0
  const selected = index !== null && index >= 0 && index < count ? index : null
  return { ...tab, selected }
}

export function selectedItem(tab: DynamoTab): Item | null {
  return tab.selected !== null ? (tab.page?.items[tab.selected] ?? null) : null
}

/** Opens the item editor. `seed` is the starting text for a new item (defaults to `{}`). */
export function openEditor(
  tab: DynamoTab,
  original: Item | null,
  mode: JsonMode,
  seed: Item = original ?? {},
): DynamoTab {
  const text = formatItem(seed, mode)
  return {
    ...tab,
    editor: {
      original,
      mode,
      text,
      initialText: text,
      stage: "edit",
      pending: null,
      error: null,
      saving: false,
      discard: null,
    },
  }
}

export function updateEditor(tab: DynamoTab, patch: Partial<ItemEditorState>): DynamoTab {
  return tab.editor ? { ...tab, editor: { ...tab.editor, ...patch } } : tab
}

export function closeEditor(tab: DynamoTab): DynamoTab {
  return { ...tab, editor: null }
}

export function isEditorDirty(editor: ItemEditorState | null): boolean {
  return editor !== null && editor.text !== editor.initialText
}

/**
 * Asks before throwing away unsaved editor text. Returns the tab with the prompt showing when
 * the editor is dirty, or null when nothing would be lost and the caller can go ahead.
 */
export function guardDiscard(tab: DynamoTab, intent: DiscardIntent): DynamoTab | null {
  if (!tab.editor || !isEditorDirty(tab.editor)) return null
  return updateEditor(tab, { discard: intent })
}

export function isDynamoTabDirty(tab: DynamoTab): boolean {
  return isEditorDirty(tab.editor)
}
