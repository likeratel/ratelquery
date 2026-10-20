import type { PointerEvent as ReactPointerEvent } from "react"
import { create } from "zustand"
import { canDrop, moveItem, type DropPosition, type LayoutRef } from "../../lib/connectionLayout"
import { currentLayout, useConnectionLayout } from "../../state/connectionLayoutStore"
import { DRAG_THRESHOLD_PX, dropPosition, readDragRef } from "./layoutTree"

interface DropTarget {
  ref: LayoutRef
  position: DropPosition
}

interface DragState {
  dragging: LayoutRef | null
  over: DropTarget | null
}

/** The row being dragged and where it would land; rows read it to draw the drop indicator. */
export const useDragState = create<DragState>(() => ({ dragging: null, over: null }))

const IDLE: DragState = { dragging: null, over: null }

/** Presses on these never start a drag. */
const NO_DRAG = "[data-tree-toggle], [data-tree-menu], input, [role='menu']"

/** Swallows the click the browser sends after a drag ends over a button. */
function suppressNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener("click", swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0)
}

function targetAt(tree: HTMLElement, ref: LayoutRef, x: number, y: number): DropTarget | null {
  const line = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drag-type]") ?? null
  const target = readDragRef(line)
  if (!line || !target || !tree.contains(line)) return null
  const rect = line.getBoundingClientRect()
  const position = dropPosition(ref, target, (y - rect.top) / Math.max(rect.height, 1))
  return canDrop(currentLayout(), ref, target, position) ? { ref: target, position } : null
}

/**
 * Pointer-driven drag and drop for the connection list (HTML5 drag events are taken over by
 * the desktop shell's file drop on some platforms). Rows mark their line with
 * `dragAttributes`; the returned handler goes on the tree. Escape cancels a drag.
 */
export function useLayoutDrag(enabled: boolean) {
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || event.metaKey || event.ctrlKey) return
    const start = event.target as Element
    if (start.closest(NO_DRAG)) return
    const ref = readDragRef(start.closest("[data-drag-type]"))
    if (!ref) return
    const tree = event.currentTarget
    const origin = { x: event.clientX, y: event.clientY }
    let active = false
    let cancelled = false

    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("keydown", onKey, true)
      useDragState.setState(IDLE)
    }
    const onMove = (move: PointerEvent) => {
      if (cancelled) return
      if (!active) {
        const distance = Math.hypot(move.clientX - origin.x, move.clientY - origin.y)
        if (distance < DRAG_THRESHOLD_PX) return
        active = true
      }
      useDragState.setState({
        dragging: ref,
        over: targetAt(tree, ref, move.clientX, move.clientY),
      })
    }
    const onUp = () => {
      const { over } = useDragState.getState()
      stop()
      if (!active) return
      // The release would otherwise click the row under the pointer (and open a tab).
      suppressNextClick()
      if (over && !cancelled) {
        useConnectionLayout
          .getState()
          .update((layout) => moveItem(layout, ref, over.ref, over.position))
      }
    }
    const onKey = (key: KeyboardEvent) => {
      if (key.code !== "Escape" || !active || cancelled) return
      key.preventDefault()
      key.stopPropagation()
      // Keep listening for the release so it doesn't click the row.
      cancelled = true
      useDragState.setState(IDLE)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("keydown", onKey, true)
  }
  return { onPointerDown }
}
