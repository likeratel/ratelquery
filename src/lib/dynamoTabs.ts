import type { ConnectionId } from "./connections"
import type { DynamoExportRequest, ExpectedValue, Item, KeySchema, Page } from "./dynamo"
import { itemKey } from "./dynamoDiff"
import { EMPTY_DYNAMO_EDITS, pendingEditCount, type DynamoEdits } from "./dynamoEdits"
import { findLossyAttributes, formatItem, type JsonMode } from "./dynamoJson"
import { EMPTY_FORM, type DynamoForm, type DynamoMode } from "./dynamoRequest"
import { DEFAULT_TREE_EXPANSION, type TreeExpansion } from "./dynamoTree"
import type { AppError } from "./ipc"

export type ItemView = "table" | "json"

/** How the item side panel shows the selected item. */
export type DetailView = "tree" | "json"

/** Choices of the item side panel, kept while moving between items like `view`. */
export interface ItemPanel {
  view: DetailView
  /**
   * Plain or wire JSON, as last picked in the panel's JSON view or the editor. The editor
   * opens in it, unless plain would change the item (see `jsonModeFor`).
   */
  mode: JsonMode
  /** Open nodes by path, so the next item of the table opens the same way. */
  tree: TreeExpansion
  /** Set while the panel lists the selected item's pending changes before Apply. */
  reviewing: boolean
}

export const DEFAULT_ITEM_PANEL: ItemPanel = {
  view: "tree",
  mode: "plain",
  tree: DEFAULT_TREE_EXPANSION,
  reviewing: false,
}

/** What the user asked for while the editor had unsaved changes, awaiting "Discard changes?". */
export type DiscardIntent =
  | { kind: "close" }
  | { kind: "table"; table: string }
  /** Open the editor on another item, or on a new one when `item` is null. */
  | { kind: "open"; item: Item | null }

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
  /**
   * Pending grid or tree changes of the item that moved into the text when the editor opened.
   * They are saved with the item, or dropped with the editor.
   */
  carried: number
  /**
   * What the carried changes started from. Saving over the item requires all of it to still
   * hold, so the editor keeps the protection the inline edits had.
   */
  expected: readonly ExpectedValue[]
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
  /**
   * An item shown in the side panel that isn't on the page, such as one just created before
   * any request ran. A page selection replaces it.
   */
  detail: Item | null
  view: ItemView
  panel: ItemPanel
  editor: ItemEditorState | null
  /** Inline grid edits waiting for Apply, keyed by item key so they outlive a page refresh. */
  edits: DynamoEdits
  /** Set while Apply writes the pending edits. */
  applying: boolean
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
    detail: null,
    view: "table",
    panel: DEFAULT_ITEM_PANEL,
    editor: null,
    edits: EMPTY_DYNAMO_EDITS,
    applying: false,
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
    // Paths mean something else in another table; the view and JSON mode carry over.
    panel: { ...tab.panel, tree: DEFAULT_TREE_EXPANSION, reviewing: false },
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
    detail: null,
    panel: { ...tab.panel, reviewing: false },
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
  if (selected === tab.selected && tab.detail === null) return tab
  return { ...tab, selected, detail: null, panel: { ...tab.panel, reviewing: false } }
}

/** Shows `item` in the side panel without a page row behind it. */
export function showDetail(tab: DynamoTab, item: Item): DynamoTab {
  return { ...tab, selected: null, detail: item, panel: { ...tab.panel, reviewing: false } }
}

/** What Mod+S does in the item panel. It never applies other items' changes from there. */
export type PanelApplyStep = "review" | "apply" | "nothing"

export function panelApplyStep(panel: ItemPanel, itemHasEdits: boolean): PanelApplyStep {
  if (!itemHasEdits) return "nothing"
  return panel.reviewing ? "apply" : "review"
}

export function updatePanel(tab: DynamoTab, patch: Partial<ItemPanel>): DynamoTab {
  return { ...tab, panel: { ...tab.panel, ...patch } }
}

/**
 * The JSON mode to show or edit `item` in: the preferred one, but wire when plain JSON would
 * change the item (sets, binary, imprecise numbers) or the table has a binary key.
 */
export function jsonModeFor(item: Item, preferred: JsonMode, schema: KeySchema | null): JsonMode {
  const binaryKey = schema?.hash.type === "B" || schema?.range?.type === "B"
  return findLossyAttributes(item).length > 0 || binaryKey ? "wire" : preferred
}

export function selectedItem(tab: DynamoTab): Item | null {
  if (tab.selected === null) return tab.detail
  return tab.page?.items[tab.selected] ?? null
}

/** Pending changes an editor takes over: how many, and the values they started from. */
export interface CarriedChanges {
  count: number
  expected: readonly ExpectedValue[]
}

const NOTHING_CARRIED: CarriedChanges = { count: 0, expected: [] }

/**
 * Opens the item editor. `seed` is the starting text: a new item's template (defaults to `{}`),
 * or `original` with the `carried` pending changes applied, which leaves the editor dirty.
 */
export function openEditor(
  tab: DynamoTab,
  original: Item | null,
  mode: JsonMode,
  seed: Item = original ?? {},
  carried: CarriedChanges = NOTHING_CARRIED,
): DynamoTab {
  const text = formatItem(seed, mode)
  return {
    ...tab,
    editor: {
      original,
      mode,
      text,
      initialText: carried.count > 0 && original ? formatItem(original, mode) : text,
      stage: "edit",
      pending: null,
      error: null,
      saving: false,
      discard: null,
      carried: carried.count,
      expected: carried.expected,
    },
  }
}

export function updateEditor(tab: DynamoTab, patch: Partial<ItemEditorState>): DynamoTab {
  return tab.editor ? { ...tab, editor: { ...tab.editor, ...patch } } : tab
}

export function closeEditor(tab: DynamoTab): DynamoTab {
  return { ...tab, editor: null }
}

/**
 * Identifies the item an editor is open on: "new", or the item's table key. A different identity
 * means a different document, so the view starts over (fresh undo history).
 */
export function editorIdentity(editor: ItemEditorState, schema: KeySchema | null): string {
  if (!editor.original) return "new"
  const key = schema ? itemKey(editor.original, schema) : null
  return `edit:${JSON.stringify(key ?? editor.original)}`
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

export function hasPendingEdits(tab: DynamoTab): boolean {
  return pendingEditCount(tab.edits) > 0
}

export function isDynamoTabDirty(tab: DynamoTab): boolean {
  return isEditorDirty(tab.editor) || hasPendingEdits(tab)
}
