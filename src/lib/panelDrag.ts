/** The element attribute toggled for the length of a drag (the document root in the app). */
export interface DragMarker {
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}

export const DRAG_ATTRIBUTE = "data-col-resizing"

interface PanelDragOptions {
  /** Receives `pointermove`, `pointerup` and `pointercancel` (the captured handle). */
  target: EventTarget
  marker: DragMarker
  startX: number
  /** Called with the horizontal distance from the start on every pointer move. */
  onMove: (deltaX: number) => void
  /** Called once when the drag ends, whether by pointer release or by `end()`. */
  onEnd: () => void
}

/**
 * Tracks one pointer drag of a resize handle and returns a function that ends it. The drag ends
 * on pointer release or cancel, or when the returned function is called (the handle unmounting
 * mid-drag); either way listeners are detached, the marker attribute removed and `onEnd` called
 * exactly once.
 */
export function startPanelDrag({
  target,
  marker,
  startX,
  onMove,
  onEnd,
}: PanelDragOptions): () => void {
  let active = true
  const move = (event: Event) => onMove((event as PointerEvent).clientX - startX)
  const end = () => {
    if (!active) return
    active = false
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", end)
    target.removeEventListener("pointercancel", end)
    marker.removeAttribute(DRAG_ATTRIBUTE)
    onEnd()
  }
  marker.setAttribute(DRAG_ATTRIBUTE, "")
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", end)
  target.addEventListener("pointercancel", end)
  return end
}
