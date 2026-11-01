import type { FocusEvent, KeyboardEvent } from "react"
import { isImeComposing } from "../../lib/shortcuts"
import { useSchemaTree } from "./treeStore"

/**
 * Keyboard support for the sidebar tree (WAI-ARIA tree pattern), driven by the DOM so every
 * level can render its own rows. A treeitem marks its parts with data attributes:
 * `data-tree-toggle` (expand / collapse), `data-tree-action` (Enter) and `data-tree-menu`
 * (context menu key, Shift+F10). A filter box with `data-tree-filter` joins Up / Down only.
 */

const ITEM = '[role="treeitem"]'
const NAVIGABLE = `${ITEM}, [data-tree-filter]`

/** The first element matching `selector` that belongs to `item` itself, not a nested item. */
function own(item: HTMLElement, selector: string): HTMLElement | null {
  const matches = item.querySelectorAll<HTMLElement>(selector)
  return [...matches].find((el) => el.closest(ITEM) === item) ?? null
}

function moveFocus(tree: HTMLElement, from: HTMLElement, step: number | "first" | "last") {
  const nodes = [...tree.querySelectorAll<HTMLElement>(NAVIGABLE)]
  const index = nodes.indexOf(from)
  const target =
    step === "first"
      ? 0
      : step === "last"
        ? nodes.length - 1
        : Math.min(Math.max(index + step, 0), nodes.length - 1)
  nodes[target]?.focus()
}

/** Returns true when the key was handled. */
function handleItemKey(tree: HTMLElement, item: HTMLElement, event: KeyboardEvent): boolean {
  const expanded = item.getAttribute("aria-expanded")
  switch (event.code) {
    case "ArrowDown":
      moveFocus(tree, item, 1)
      return true
    case "ArrowUp":
      moveFocus(tree, item, -1)
      return true
    case "Home":
      moveFocus(tree, item, "first")
      return true
    case "End":
      moveFocus(tree, item, "last")
      return true
    case "ArrowRight":
      if (expanded === "false") own(item, "[data-tree-toggle]")?.click()
      else if (expanded === "true") item.querySelector<HTMLElement>(ITEM)?.focus()
      return true
    case "ArrowLeft":
      if (expanded === "true") own(item, "[data-tree-toggle]")?.click()
      else item.parentElement?.closest<HTMLElement>(ITEM)?.focus()
      return true
    case "Enter":
      ;(own(item, "[data-tree-action]") ?? own(item, "[data-tree-toggle]"))?.click()
      return true
    case "ContextMenu":
      own(item, "[data-tree-menu]")?.click()
      return true
    case "F10":
      if (!event.shiftKey) return false
      own(item, "[data-tree-menu]")?.click()
      return true
    default:
      return false
  }
}

export function handleTreeKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (isImeComposing(event.nativeEvent) || event.metaKey || event.ctrlKey || event.altKey) return
  const tree = event.currentTarget
  const target = event.target as HTMLElement
  let handled = false
  if (target.getAttribute("role") === "treeitem") {
    handled = handleItemKey(tree, target, event)
  } else if (target.hasAttribute("data-tree-filter")) {
    const step = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0
    if (step) moveFocus(tree, target, step)
    handled = step !== 0
  }
  if (handled) event.preventDefault()
}

/** Keeps the single tab stop on whichever node last received focus. */
export function handleTreeFocus(event: FocusEvent<HTMLElement>): void {
  const item = (event.target as HTMLElement).closest<HTMLElement>(ITEM)
  const key = item?.dataset.treeKey
  if (key !== undefined) useSchemaTree.getState().setFocused(key)
}

/**
 * `tabIndex` for a node: 0 for the tree's tab stop, -1 otherwise. `fallback` makes the node the
 * tab stop while no rendered node holds it (the list decides that for its first row).
 */
export function useTreeTabIndex(key: string, fallback = false): 0 | -1 {
  const focused = useSchemaTree((s) => s.focused === key)
  return focused || fallback ? 0 : -1
}
