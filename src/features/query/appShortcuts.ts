import { dismissToast, showToast } from "../../components/ui"
import { matchesShortcut, parseShortcut, type KeyLike, type Shortcut } from "../../lib/shortcuts"
import { SLOT_COUNT } from "../../lib/tabGroups"
import { formatZoom, ZOOM_SHORTCUTS, type ZoomAction } from "../../lib/zoom"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"
import { stepUiZoom } from "../../state/uiZoom"
import { reviewActiveEdit, runActiveDynamo } from "../dynamo/actions"
import { applyActiveEdits, closeActiveTab, newTabFromActive, runActiveTab } from "./actions"

export const APP_SHORTCUTS = {
  newTab: parseShortcut("Mod+T"),
  closeTab: parseShortcut("Mod+W"),
  /** The statement at the cursor, or the DynamoDB form. */
  runStatement: parseShortcut("Mod+Enter"),
  /** The selected editor text, or the whole editor when nothing is selected. */
  runSelection: parseShortcut("Mod+Shift+Enter"),
  apply: parseShortcut("Mod+S"),
  toggleSidebar: parseShortcut("Mod+B"),
  settings: parseShortcut("Mod+,"),
} as const

const SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1)

/**
 * Chrome's tab keys, by physical digit: Mod+1..8 pick a tab of the active connection and Mod+9
 * its last tab; Mod+Alt+1..9 do the same for the connections. Alt changes the produced
 * character on macOS, which is one more reason these match `KeyboardEvent.code`.
 */
export const SLOT_SHORTCUTS: Readonly<{
  tab: readonly Shortcut[]
  connection: readonly Shortcut[]
}> = {
  tab: SLOTS.map((slot) => parseShortcut(`Mod+${slot}`)),
  connection: SLOTS.map((slot) => parseShortcut(`Mod+Alt+${slot}`)),
}

export interface ShortcutContext {
  /** Cursor offset when the event came from the SQL editor. */
  cursor?: number
  /** Selected editor text when the event came from the SQL editor. */
  selectedText?: string
}

/**
 * Handles an application shortcut matched on the physical key. Returns true when the event was
 * consumed; the caller then prevents the default action. Used by both the window listener and
 * the editor's keydown capture so the two never disagree.
 */
export function handleAppShortcut(event: KeyLike, context: ShortcutContext = {}): boolean {
  const action = matchAppShortcut(event)
  if (!action) return false
  // A held key still belongs to the shortcut (so the editor doesn't type it), but runs once.
  // Zoom repeats like a browser's; its save is debounced, so that costs one write.
  if (event.repeat && !isZoomAction(action)) return true
  runAppShortcut(action, context)
  return true
}

/** Selects a tab (`tab`) or a connection group (`connection`) by its 1-based position. */
export interface SlotShortcut {
  scope: keyof typeof SLOT_SHORTCUTS
  slot: number
}

export interface ZoomShortcut {
  zoom: ZoomAction
}

export type AppShortcut = keyof typeof APP_SHORTCUTS | SlotShortcut | ZoomShortcut

const isZoomAction = (action: AppShortcut): action is ZoomShortcut =>
  typeof action === "object" && "zoom" in action

function matchZoomShortcut(event: KeyLike): ZoomShortcut | null {
  const actions = Object.keys(ZOOM_SHORTCUTS) as ZoomAction[]
  const zoom = actions.find((action) =>
    ZOOM_SHORTCUTS[action].some((shortcut) => matchesShortcut(event, shortcut)),
  )
  return zoom ? { zoom } : null
}

/** Zoom keys work while a modal dialog is open (Settings hosts the zoom picker), unlike the rest. */
export function isZoomShortcut(event: KeyLike): boolean {
  return matchZoomShortcut(event) !== null
}

function matchSlotShortcut(event: KeyLike): SlotShortcut | null {
  for (const scope of ["tab", "connection"] as const) {
    const index = SLOT_SHORTCUTS[scope].findIndex((shortcut) => matchesShortcut(event, shortcut))
    if (index !== -1) return { scope, slot: index + 1 }
  }
  return null
}

/** The application shortcut `event` matches, if any. */
export function matchAppShortcut(event: KeyLike): AppShortcut | null {
  const slot = matchSlotShortcut(event)
  if (slot) return slot
  const zoom = matchZoomShortcut(event)
  if (zoom) return zoom
  // Shift+Enter is checked before Enter so the longer combination wins.
  const order: readonly (keyof typeof APP_SHORTCUTS)[] = [
    "runSelection",
    "runStatement",
    "newTab",
    "closeTab",
    "apply",
    "toggleSidebar",
    "settings",
  ]
  return order.find((name) => matchesShortcut(event, APP_SHORTCUTS[name])) ?? null
}

/** The toast showing the current zoom; replaced on each step so presses don't pile up. */
let zoomToastId: number | null = null

function runZoom(action: ZoomAction): void {
  const level = stepUiZoom(action)
  if (level === null) return
  if (zoomToastId !== null) dismissToast(zoomToastId)
  zoomToastId = showToast({ tone: "info", message: `Zoom ${formatZoom(level)}` })
}

function runAppShortcut(action: AppShortcut, context: ShortcutContext): void {
  if (isZoomAction(action)) {
    runZoom(action.zoom)
    return
  }
  if (typeof action === "object") {
    const tabs = useTabsStore.getState()
    if (action.scope === "tab") tabs.activateTabSlot(action.slot)
    else tabs.activateConnectionSlot(action.slot)
    return
  }
  const dynamo = selectActiveTab(useTabsStore.getState())?.kind === "dynamo"
  switch (action) {
    case "runStatement":
      if (dynamo) runActiveDynamo()
      else void runActiveTab("statement", context)
      return
    case "runSelection":
      if (dynamo) runActiveDynamo()
      else void runActiveTab("selection", context)
      return
    case "newTab":
      newTabFromActive()
      return
    case "closeTab":
      closeActiveTab()
      return
    case "apply":
      if (dynamo) reviewActiveEdit()
      else void applyActiveEdits()
      return
    case "toggleSidebar":
      useUiStore.getState().toggleSidebar()
      return
    case "settings":
      useUiStore.getState().openSettings()
      return
  }
}
