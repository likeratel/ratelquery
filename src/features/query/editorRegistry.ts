import type { EditorView } from "@codemirror/view"

/** The mounted editor per tab, so shortcuts fired outside the editor can read the cursor. */
const views = new Map<string, EditorView>()

export function registerEditor(tabId: string, view: EditorView | null): void {
  if (view) views.set(tabId, view)
  else views.delete(tabId)
}

export function editorFor(tabId: string): EditorView | undefined {
  return views.get(tabId)
}
