import { createPortal } from "react-dom"
import type { Point } from "../../lib/menuPosition"
import { Menu, type MenuItem } from "../ui/Menu"

/** Class on the context menu, so the grid can tell whether focus is still inside it. */
export const GRID_CONTEXT_MENU_CLASS = "grid-context-menu"

interface GridContextMenuProps {
  position: Point
  items: readonly MenuItem[]
  onClose: () => void
}

/**
 * Menu at the pointer for a right-clicked row. Rendered into the body, so the grid's scroll
 * area and the translated row slots can't clip or offset it.
 */
export function GridContextMenu({ position, items, onClose }: GridContextMenuProps) {
  return createPortal(
    <Menu
      label="Row actions"
      className={`grid-menu ${GRID_CONTEXT_MENU_CLASS}`}
      position={position}
      items={items}
      onClose={onClose}
    />,
    document.body,
  )
}
