import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { startPanelDrag } from "../../lib/panelDrag"
import { dragWidth, panelCap, shownWidth, type PanelSpec } from "../../lib/panelWidths"
import "./ui.css"

const KEY_STEP = 16

/**
 * Width of the element the panel's column is a share of. The handle is positioned in the same
 * element, so it is the handle's offset parent.
 */
function containerWidth(handle: HTMLElement | null): number {
  const container = handle?.offsetParent
  return container instanceof HTMLElement ? container.clientWidth : Infinity
}

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
 * The panel may be shown narrower than `width` (capped at `spec.maxPercent` of its container), so
 * resizing starts from the width shown and never stores more than can be seen.
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
  const ref = useRef<HTMLDivElement>(null)
  // Only for the announced value; resizing measures the container when it starts.
  const [available, setAvailable] = useState(Infinity)

  useEffect(() => {
    const container = ref.current?.offsetParent
    if (!(container instanceof HTMLElement)) return
    const observer = new ResizeObserver(() => setAvailable(container.clientWidth))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Unmounting mid-drag (say the sidebar collapses by shortcut) must still end the drag.
  useEffect(() => () => endDrag.current?.(), [])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    endDrag.current?.()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startWidth = width
    const container = containerWidth(handle)
    let last: number | null = null
    onDragChange?.(true)
    endDrag.current = startPanelDrag({
      target: handle,
      marker: document.documentElement,
      startX: event.clientX,
      onMove: (delta) => {
        last = dragWidth(spec, startWidth, delta, edge, container)
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
    const container = containerWidth(event.currentTarget)
    const step = (delta: number) => onResize(dragWidth(spec, width, delta, edge, container), true)
    if (event.code === "ArrowLeft") step(-KEY_STEP)
    else if (event.code === "ArrowRight") step(KEY_STEP)
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={ref}
      className={className ? `resize-handle ${className}` : "resize-handle"}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={shownWidth(spec, width, available)}
      aria-valuemin={Math.min(spec.min, panelCap(spec, available))}
      aria-valuemax={Math.min(spec.max, panelCap(spec, available))}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(spec.defaultWidth, true)}
    />
  )
}
