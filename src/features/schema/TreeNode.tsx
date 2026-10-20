import { ChevronRight, Ellipsis } from "lucide-react"
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Menu, type MenuItem } from "../../components/ui"
import { useTreeTabIndex } from "./treeKeyboard"
import { useTreeLevel } from "./treeLevel"

/** Indentation for a row at `level` (1 is a connection); the CSS multiplies it by 14px. */
export const depthStyle = (level: number) => ({ "--tree-depth": level - 1 }) as CSSProperties

export function TreeChevron({
  expanded,
  label,
  onToggle,
}: {
  expanded: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="tree-chevron"
      tabIndex={-1}
      data-tree-toggle=""
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <ChevronRight size={13} strokeWidth={2} aria-hidden />
    </button>
  )
}

interface TreeNodeProps {
  nodeKey: string
  /** aria-level for a top-level connection's subtree (connections are 1); `TreeLevelOffset` adds to it. */
  level: number
  label: string
  icon: ReactNode
  /** Undefined for a leaf. */
  expanded?: boolean
  onToggle?: () => void
  /** Row click and Enter. Without it they toggle the node. */
  onActivate?: () => void
  selected?: boolean
  title?: string
  menuItems?: readonly MenuItem[]
  /** Group content, rendered only while expanded. */
  children?: ReactNode
}

/** One tree row with an optional chevron, "…" menu (also on right click) and child group. */
export function TreeNode({
  nodeKey,
  level,
  label,
  icon,
  expanded,
  onToggle,
  onActivate,
  selected,
  title,
  menuItems,
  children,
}: TreeNodeProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const itemRef = useRef<HTMLLIElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const tabIndex = useTreeTabIndex(nodeKey)
  const ariaLevel = useTreeLevel(level)
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    const item = itemRef.current
    // Selecting an item or Esc leaves focus in the closing menu; hand it back to the row.
    if (item?.contains(document.activeElement)) item.focus()
  }, [])
  const hasMenu = Boolean(menuItems && menuItems.length > 0)

  return (
    <li
      ref={itemRef}
      role="treeitem"
      className="tree-item"
      aria-level={ariaLevel}
      aria-expanded={expanded}
      aria-selected={selected}
      aria-label={label}
      data-tree-key={nodeKey}
      tabIndex={tabIndex}
    >
      <div className="tree-line" data-menu={menuOpen || undefined}>
        <div
          className="tree-row"
          style={depthStyle(ariaLevel)}
          title={title}
          data-tree-action={onActivate ? "" : undefined}
          onClick={onActivate ?? onToggle}
          onContextMenu={
            hasMenu
              ? (event) => {
                  event.preventDefault()
                  setMenuOpen(true)
                }
              : undefined
          }
        >
          {expanded === undefined || !onToggle ? (
            <span className="tree-row__twisty" aria-hidden />
          ) : (
            <TreeChevron expanded={expanded} label={label} onToggle={onToggle} />
          )}
          <span className="tree-row__icon">{icon}</span>
          <span className="tree-row__name">{label}</span>
          {hasMenu && (
            <button
              ref={moreRef}
              type="button"
              className="ui-icon-button tree-row__more"
              tabIndex={-1}
              data-tree-menu=""
              aria-label={`Actions for ${label}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation()
                setMenuOpen((open) => !open)
              }}
            >
              <Ellipsis size={13} strokeWidth={2} />
            </button>
          )}
        </div>
        {menuOpen && menuItems && (
          <Menu
            label={`Actions for ${label}`}
            className="tree-menu"
            triggerRef={moreRef}
            onClose={closeMenu}
            items={menuItems}
          />
        )}
      </div>
      {expanded && children && (
        <ul role="group" className="tree-group">
          {children}
        </ul>
      )}
    </li>
  )
}
