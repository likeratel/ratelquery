import type { KeyboardEvent, PointerEvent } from "react"
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
  onResize: (width: number) => void
  /** Called with true when a pointer drag starts and false when it ends. */
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
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = width
    const root = document.documentElement
    root.setAttribute("data-col-resizing", "")
    onDragChange?.(true)
    const onMove = (move: globalThis.PointerEvent) =>
      onResize(dragWidth(spec, startWidth, move.clientX - startX, edge))
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
      root.removeAttribute("data-col-resizing")
      onDragChange?.(false)
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrows move the separator itself, so on a left-edge handle ArrowLeft widens the panel.
    if (event.code === "ArrowLeft") onResize(dragWidth(spec, width, -KEY_STEP, edge))
    else if (event.code === "ArrowRight") onResize(dragWidth(spec, width, KEY_STEP, edge))
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
      onDoubleClick={() => onResize(spec.defaultWidth)}
    />
  )
}
