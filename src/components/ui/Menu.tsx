import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react"
import "./ui.css"

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  tone?: "default" | "danger"
  onSelect: () => void
}

interface MenuProps {
  label: string
  items: readonly MenuItem[]
  onClose: () => void
  className?: string
}

/** Small popover menu. Closes on outside pointer, Esc, Tab or selection. */
export function Menu({ label, items, onClose, className }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    return () => window.removeEventListener("pointerdown", onPointerDown, true)
  }, [onClose])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.code === "Escape" || event.code === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    const step = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
    const index = buttons.findIndex((button) => button === document.activeElement)
    buttons[(index + step + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={["ui-menu", className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="ui-menu__item"
          data-tone={item.tone ?? "default"}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
