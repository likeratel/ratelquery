import { TREE_EDIT_SHORTCUTS } from "../../lib/dynamoTreeView"
import { FIND_SHORTCUT } from "../../lib/findShortcut"
import { parseShortcut } from "../../lib/shortcuts"

/** Shortcuts local to the DynamoDB item panel and editor; run / save / tabs live in APP_SHORTCUTS. */
export const DYNAMO_SHORTCUTS = {
  closeEditor: parseShortcut("Escape"),
  /** Opens the item panel's find bar; see `findShortcutTarget` for where else it goes. */
  find: FIND_SHORTCUT,
  findNext: parseShortcut("Enter"),
  findPrevious: parseShortcut("Shift+Enter"),
  /** Bare Enter or F2 on a focused tree value opens its field; see `startsTreeEdit`. */
  editValue: TREE_EDIT_SHORTCUTS.edit,
  editValueAlt: TREE_EDIT_SHORTCUTS.editAlt,
  /** In a tree value's open field; see `treeFieldKey`. */
  commitValue: TREE_EDIT_SHORTCUTS.commit,
  cancelValue: TREE_EDIT_SHORTCUTS.cancel,
} as const
