import { isMac, matchesShortcut, parseShortcut, type KeyLike } from "./shortcuts"

/**
 * How the item panel's tree shows and edits its rows: which keys open, commit and close a
 * value's field.
 */

/** Keys of a value's field in the tree, matched on the physical key with no modifier held. */
export const TREE_EDIT_SHORTCUTS = {
  /** On a focused value: opens its field. */
  edit: parseShortcut("Enter"),
  /** Also opens a focused value's field, as F2 renames in a file manager. */
  editAlt: parseShortcut("F2"),
  /** In the open field: stages the value and closes the field. */
  commit: parseShortcut("Enter"),
  /** In the open field: closes it without staging. */
  cancel: parseShortcut("Escape"),
} as const

/** A keydown, native or React's `nativeEvent`, with its IME composition state. */
export type TreeKeyEvent = KeyLike & { isComposing: boolean }

/**
 * Whether a key on a focused value opens its field: bare Enter or F2 only. Mod+Enter and
 * Shift+Enter belong to the app (Run), and a key that ends an IME composition to the IME.
 */
export function startsTreeEdit(event: TreeKeyEvent, mac = isMac()): boolean {
  if (event.isComposing) return false
  return (
    matchesShortcut(event, TREE_EDIT_SHORTCUTS.edit, mac) ||
    matchesShortcut(event, TREE_EDIT_SHORTCUTS.editAlt, mac)
  )
}

/**
 * What a key does in a value's open field. `composing` while an IME composition is open: Enter
 * then confirms a Hangul syllable or kana, and Esc drops the composition, so neither may commit
 * or close the field mid-word. Enter with Mod or Ctrl held is left to the app's shortcuts.
 */
export function treeFieldKey(
  event: TreeKeyEvent,
  mac = isMac(),
): "composing" | "commit" | "cancel" | null {
  if (event.isComposing) return "composing"
  if (matchesShortcut(event, TREE_EDIT_SHORTCUTS.commit, mac)) return "commit"
  if (matchesShortcut(event, TREE_EDIT_SHORTCUTS.cancel, mac)) return "cancel"
  return null
}
