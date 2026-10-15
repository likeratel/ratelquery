/** Toolbar button that takes focus back from a closed item editor. */
export type EditorReturnTarget = "edit" | "new"

/**
 * Where focus goes when the item editor closes. Only when the editor just closed and took
 * focus with it (focus fell back to the page body); a click elsewhere keeps its own focus.
 * "Edit item" is preferred, "New item" when no item is selected to edit.
 */
export function editorReturnTarget(
  wasOpen: boolean,
  isOpen: boolean,
  focusLost: boolean,
  canEdit: boolean,
): EditorReturnTarget | null {
  if (!wasOpen || isOpen || !focusLost) return null
  return canEdit ? "edit" : "new"
}
