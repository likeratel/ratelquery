import {
  isImeComposing,
  isMac,
  matchesShortcut,
  parseShortcut,
  type ImeKeyLike,
  type KeyLike,
} from "./shortcuts"

/** Mod+F, matched on the physical F key so it works under any input source. */
export const FIND_SHORTCUT = parseShortcut("Mod+F")

/** Where keyboard focus was when Mod+F came. */
export interface FindFocus {
  /** Inside a CodeMirror editor or its search panel. */
  editor: boolean
  /** In the item panel's find bar. */
  findBar: boolean
  /** In any other text field: the Scan / Query form, the table or connection filter. */
  textField: boolean
}

/** What the window shows. */
export interface FindScreen {
  /** A DynamoDB tab is the active tab. */
  dynamo: boolean
  /**
   * The item side panel: its tree or JSON view, `other` while it shows the item editor or the
   * review before Apply, null when no item is open.
   */
  panel: "tree" | "json" | "other" | null
  modalOpen: boolean
}

/**
 * - `ignore`: leave the key alone (CodeMirror's own search, another text field, a dialog).
 * - `find`: open and focus the tree's find bar, selecting its query.
 * - `json`: open the search of the panel's JSON view.
 * - `tables`: focus "Filter tables", since no item is open to search.
 */
export type FindTarget = "ignore" | "find" | "json" | "tables"

type FindKeyEvent = KeyLike & ImeKeyLike & { defaultPrevented: boolean }

/** Which part of the window Mod+F goes to, like Cmd+F in a browser. */
export function findShortcutTarget(
  event: FindKeyEvent,
  focus: FindFocus,
  screen: FindScreen,
  mac = isMac(),
): FindTarget {
  // A handled key belongs to whoever handled it: CodeMirror marks its own Mod+F that way.
  if (isImeComposing(event) || event.defaultPrevented) return "ignore"
  if (!matchesShortcut(event, FIND_SHORTCUT, mac)) return "ignore"
  if (screen.modalOpen || !screen.dynamo || focus.editor) return "ignore"
  if (focus.findBar) return "find"
  if (focus.textField) return "ignore"
  switch (screen.panel) {
    case "tree":
      return "find"
    case "json":
      return "json"
    case "other":
      return "ignore"
    case null:
      return "tables"
  }
}
