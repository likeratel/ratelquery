import type { AppShortcut } from "../../features/query/appShortcuts"

/** What an app shortcut does while the Trash panel covers the tabs. */
export type TrashShortcutDecision = "close-trash" | "ignore" | "pass"

/**
 * Mod+W closes the Trash instead of a tab. Shortcuts that act on the active tab (run, apply,
 * new tab, close the connection, tab and connection slots) are ignored, since that tab isn't
 * on screen. The sidebar and Settings shortcuts work as usual.
 */
export function trashShortcutDecision(shortcut: AppShortcut | null): TrashShortcutDecision {
  if (shortcut === null) return "pass"
  if (shortcut === "closeTab") return "close-trash"
  if (shortcut === "toggleSidebar" || shortcut === "settings") return "pass"
  return "ignore"
}
