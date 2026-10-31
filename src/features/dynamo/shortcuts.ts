import { FIND_SHORTCUT } from "../../lib/findShortcut"
import { parseShortcut } from "../../lib/shortcuts"

/** Shortcuts local to the DynamoDB item panel and editor; run / save / tabs live in APP_SHORTCUTS. */
export const DYNAMO_SHORTCUTS = {
  closeEditor: parseShortcut("Escape"),
  /** Opens the item panel's find bar; see `findShortcutTarget` for where else it goes. */
  find: FIND_SHORTCUT,
  findNext: parseShortcut("Enter"),
  findPrevious: parseShortcut("Shift+Enter"),
} as const
