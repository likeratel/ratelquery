import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react"
import { startPanelDrag } from "../../lib/panelDrag"
import { dragWidth, type PanelSpec } from "../../lib/panelWidths"
import "./ui.css"

const KEY_STEP = 16

interface ResizeHandleProps {
  /** Current panel width in pixels. */
  width: number
  spec: PanelSpec
  /**
   * Which edge of the panel the handle sits on: "end" (right edge, dragging right grows the
   * panel) or "start" (left edge, dragging left grows it).
   */
  edge: "start" | "end"
  label: string
  className?: string
  /**
   * Called with the new width. `settled` is false for the widths a pointer drag reports while it
   * moves, and true for the final width when it ends and for keyboard and double-click changes,
   * so the caller can persist only settled widths.
   */
  onResize: (width: number, settled: boolean) => void
  /** Called with true when a pointer drag starts and false when it ends (or the handle unmounts). */
  onDragChange?: (dragging: boolean) => void
}

/**
 * Vertical separator that resizes a side panel: drag it, use ArrowLeft/ArrowRight while focused,
 * or double-click to restore the default width. The caller positions it over the panel's edge.
 */
export function ResizeHandle({
  width,
  spec,
  edge,
  label,
  className,
  onResize,
  onDragChange,
}: ResizeHandleProps) {
  const endDrag = useRef<(() => void) | null>(null)

  // Unmounting mid-drag (say the sidebar collapses by shortcut) must still end the drag.
  useEffect(() => () => endDrag.current?.(), [])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    endDrag.current?.()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startWidth = width
    let last: number | null = null
    onDragChange?.(true)
    endDrag.current = startPanelDrag({
      target: handle,
      marker: document.documentElement,
      startX: event.clientX,
      onMove: (delta) => {
        last = dragWidth(spec, startWidth, delta, edge)
        onResize(last, false)
      },
      onEnd: () => {
        endDrag.current = null
        if (last !== null) onResize(last, true)
        onDragChange?.(false)
      },
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrows move the separator itself, so on a left-edge handle ArrowLeft widens the panel.
    if (event.code === "ArrowLeft") onResize(dragWidth(spec, width, -KEY_STEP, edge), true)
    else if (event.code === "ArrowRight") onResize(dragWidth(spec, width, KEY_STEP, edge), true)
    else return
    event.preventDefault()
  }

  return (
    <div
      className={className ? `resize-handle ${className}` : "resize-handle"}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(spec.defaultWidth, true)}
    />
  )
}
