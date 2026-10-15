import { matchesShortcut, parseShortcut, type KeyLike } from "../../lib/shortcuts"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"
import { reviewActiveEdit, runActiveDynamo } from "../dynamo/actions"
import { applyActiveEdits, closeActiveTab, newTabFromActive, runActiveTab } from "./actions"

export const APP_SHORTCUTS = {
  newTab: parseShortcut("Mod+T"),
  closeTab: parseShortcut("Mod+W"),
  run: parseShortcut("Mod+Enter"),
  runStatement: parseShortcut("Mod+Shift+Enter"),
  apply: parseShortcut("Mod+S"),
  toggleSidebar: parseShortcut("Mod+B"),
  settings: parseShortcut("Mod+,"),
} as const

export interface ShortcutContext {
  /** Cursor offset when the event came from the SQL editor. */
  cursor?: number
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
  if (event.repeat) return true
  runAppShortcut(action, context)
  return true
}

export type AppShortcut = keyof typeof APP_SHORTCUTS

/** The application shortcut `event` matches, if any. */
export function matchAppShortcut(event: KeyLike): AppShortcut | null {
  // Shift+Enter is checked before Enter so the longer combination wins.
  const order: readonly AppShortcut[] = [
    "runStatement",
    "run",
    "newTab",
    "closeTab",
    "apply",
    "toggleSidebar",
    "settings",
  ]
  return order.find((name) => matchesShortcut(event, APP_SHORTCUTS[name])) ?? null
}

function runAppShortcut(action: AppShortcut, context: ShortcutContext): void {
  const dynamo = selectActiveTab(useTabsStore.getState())?.kind === "dynamo"
  switch (action) {
    case "runStatement":
      if (dynamo) runActiveDynamo()
      else void runActiveTab("statement", context.cursor)
      return
    case "run":
      if (dynamo) runActiveDynamo()
      else void runActiveTab("all")
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
