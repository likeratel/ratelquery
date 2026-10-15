import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { closesMenu } from "./menuDismiss"
import "./ui.css"

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  tone?: "default" | "danger"
  /** Second line under the label. */
  hint?: string
  disabled?: boolean
  title?: string
  onSelect: () => void
}

/** A row of exclusive options above the items (for example an export format). */
export interface MenuChoice {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}

interface MenuProps {
  label: string
  items: readonly MenuItem[]
  onClose: () => void
  className?: string
  /**
   * The button that toggles the menu. Presses on it are left to its click handler, so a second
   * click closes the menu instead of closing and reopening it.
   */
  triggerRef?: RefObject<HTMLElement | null>
  choice?: MenuChoice
  /** Small heading over the items. */
  itemsLabel?: string
}

/** Items reachable with the arrow keys, in document order. */
const NAVIGABLE = "[role=menuitem]:not(:disabled), [role=menuitemradio]"

function ChoiceRow({ choice }: { choice: MenuChoice }) {
  const labelId = useId()
  return (
    <>
      <div className="ui-menu__label" id={labelId}>
        {choice.label}
      </div>
      <div className="ui-menu__choice" role="group" aria-labelledby={labelId}>
        {choice.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === choice.value}
            className="ui-menu__choice-option"
            onClick={() => choice.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  )
}

/** Small popover menu. Closes on outside pointer, Esc, Tab or selection. */
export function Menu({
  label,
  items,
  onClose,
  className,
  triggerRef,
  choice,
  itemsLabel,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (closesMenu(event.target, ref.current, triggerRef?.current ?? null)) onClose()
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    return () => window.removeEventListener("pointerdown", onPointerDown, true)
  }, [onClose, triggerRef])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    if (event.code === "Escape" || event.code === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    const step = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(NAVIGABLE)]
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
      {choice && <ChoiceRow choice={choice} />}
      {itemsLabel && <div className="ui-menu__label">{itemsLabel}</div>}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="ui-menu__item"
          data-tone={item.tone ?? "default"}
          data-hint={item.hint ? "" : undefined}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon}
          {item.hint ? (
            <span className="ui-menu__text">
              {item.label}
              <span className="ui-menu__hint">{item.hint}</span>
            </span>
          ) : (
            item.label
          )}
        </button>
      ))}
    </div>
  )
}
