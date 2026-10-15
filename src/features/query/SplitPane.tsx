import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"

const MIN_RATIO = 0.12
const MAX_RATIO = 0.88
const KEY_STEP = 0.05
const DEFAULT_RATIO = 0.42

/** Last ratio the user chose, shared by every tab for the session. */
let rememberedRatio = DEFAULT_RATIO

const clampRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))

interface SplitPaneProps {
  top: ReactNode
  bottom: ReactNode
}

/** Vertical split with a draggable (and keyboard-adjustable) divider. */
export function SplitPane({ top, bottom }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatioState] = useState(rememberedRatio)

  const setRatio = (next: number) => {
    const clamped = clampRatio(next)
    rememberedRatio = clamped
    setRatioState(clamped)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const rect = container.getBoundingClientRect()
    const onMove = (move: globalThis.PointerEvent) =>
      setRatio((move.clientY - rect.top) / rect.height)
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.code === "ArrowUp") setRatio(ratio - KEY_STEP)
    else if (event.code === "ArrowDown") setRatio(ratio + KEY_STEP)
    else return
    event.preventDefault()
  }

  return (
    <div className="split" ref={containerRef}>
      <div className="split__pane" style={{ flexBasis: `${ratio * 100}%` }}>
        {top}
      </div>
      <div
        className="split__divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor and results"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={MIN_RATIO * 100}
        aria-valuemax={MAX_RATIO * 100}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="split__pane split__pane--fill">{bottom}</div>
    </div>
  )
}
