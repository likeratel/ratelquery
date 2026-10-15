import { matchesShortcut, parseShortcut, type KeyLike } from "../../lib/shortcuts"
import { useUiStore } from "../../state/uiStore"
import { applyActiveEdits, closeActiveTab, newTabFromActive, runActiveTab } from "./actions"

export const APP_SHORTCUTS = {
  newTab: parseShortcut("Mod+T"),
  closeTab: parseShortcut("Mod+W"),
  run: parseShortcut("Mod+Enter"),
  runStatement: parseShortcut("Mod+Shift+Enter"),
  apply: parseShortcut("Mod+S"),
  toggleSidebar: parseShortcut("Mod+B"),
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
  if (matchesShortcut(event, APP_SHORTCUTS.runStatement)) {
    void runActiveTab("statement", context.cursor)
  } else if (matchesShortcut(event, APP_SHORTCUTS.run)) {
    void runActiveTab("all")
  } else if (matchesShortcut(event, APP_SHORTCUTS.newTab)) {
    newTabFromActive()
  } else if (matchesShortcut(event, APP_SHORTCUTS.closeTab)) {
    closeActiveTab()
  } else if (matchesShortcut(event, APP_SHORTCUTS.apply)) {
    void applyActiveEdits()
  } else if (matchesShortcut(event, APP_SHORTCUTS.toggleSidebar)) {
    useUiStore.getState().toggleSidebar()
  } else {
    return false
  }
  return true
}
