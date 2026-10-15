import type { EditorState } from "@codemirror/state"

/** Editor state (undo history, selection) kept per document while its editor is unmounted. */
const stateCache = new Map<string, EditorState>()

export function cachedEditorState(stateKey: string): EditorState | undefined {
  return stateCache.get(stateKey)
}

export function cacheEditorState(stateKey: string, state: EditorState): void {
  stateCache.set(stateKey, state)
}

/** Drops the remembered editor state for a closed document. */
export function forgetEditorState(stateKey: string): void {
  stateCache.delete(stateKey)
}
