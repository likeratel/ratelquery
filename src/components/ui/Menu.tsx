import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { placeMenu, type Point } from "../../lib/menuPosition"
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
  /** Shortcut label shown at the end of the row, such as "⌘C". */
  shortcut?: string
  /** Draws a divider above the item. */
  separatorBefore?: boolean
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
  /**
   * Viewport point to open at (a context menu). The menu is fixed there, kept inside the
   * window, and also closes when anything scrolls or the window resizes.
   */
  position?: Point
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
  position,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const placed = usePlacement(ref, position, onClose)

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
      style={placed && { position: "fixed", left: placed.x, top: placed.y }}
      onKeyDown={onKeyDown}
    >
      {choice && <ChoiceRow choice={choice} />}
      {itemsLabel && <div className="ui-menu__label">{itemsLabel}</div>}
      {items.map((item) => (
        <MenuRow key={item.id} item={item} onClose={onClose} />
      ))}
    </div>
  )
}

function MenuRow({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  return (
    <>
      {item.separatorBefore && <div role="separator" className="ui-menu__separator" />}
      <button
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
        {item.shortcut && <kbd className="ui-menu__shortcut">{item.shortcut}</kbd>}
      </button>
    </>
  )
}

/**
 * Keeps a menu opened at `position` inside the viewport, measured before paint. Scrolling or
 * resizing would leave it pointing at the wrong place, so either closes it.
 */
function usePlacement(
  ref: RefObject<HTMLDivElement | null>,
  position: Point | undefined,
  onClose: () => void,
): Point | undefined {
  const [placed, setPlaced] = useState(position)
  useLayoutEffect(() => {
    const menu = ref.current
    if (!position || !menu) return
    const rect = menu.getBoundingClientRect()
    setPlaced(
      placeMenu(
        position,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
  }, [ref, position])
  useEffect(() => {
    if (!position) return
    window.addEventListener("scroll", onClose, true)
    window.addEventListener("resize", onClose)
    return () => {
      window.removeEventListener("scroll", onClose, true)
      window.removeEventListener("resize", onClose)
    }
  }, [position, onClose])
  return position ? placed : undefined
}
