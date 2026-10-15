/** CodeMirror panels (search, replace) render inside an element with this class. */
const PANEL_SELECTOR = ".cm-panel"

/**
 * True when a key event comes from a CodeMirror panel such as the search field. Keys that the
 * panel uses itself, Escape above all, belong to it rather than to the surrounding screen.
 */
export function isFromEditorPanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(PANEL_SELECTOR) !== null
}
