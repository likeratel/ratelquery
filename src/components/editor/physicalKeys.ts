import { redo, selectAll, toggleComment, undo } from "@codemirror/commands"
import type { EditorView } from "@codemirror/view"
import { matchesShortcut, parseShortcut, type KeyLike } from "../../lib/shortcuts"

/**
 * CodeMirror's own keymap matches on `event.key`, which a Korean or Japanese input source turns
 * into a jamo or kana, so ⌘A, ⌘Z and friends stop working there. These bindings match the
 * physical key instead and run the same commands.
 */
const BINDINGS: ReadonlyArray<[ReturnType<typeof parseShortcut>, (view: EditorView) => boolean]> = [
  [parseShortcut("Mod+A"), selectAll],
  [parseShortcut("Mod+Shift+Z"), redo],
  [parseShortcut("Mod+Z"), undo],
  [parseShortcut("Mod+/"), toggleComment],
]

/** Runs the editing command for a physical-key chord; returns true when one matched. */
export function runPhysicalEditingShortcut(event: KeyLike, view: EditorView): boolean {
  for (const [shortcut, command] of BINDINGS) {
    if (matchesShortcut(event, shortcut)) return command(view)
  }
  return false
}
