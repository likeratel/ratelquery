import { Ellipsis, Folder, FolderOpen, Pencil, Trash } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Menu } from "../../components/ui"
import {
  deleteFolder,
  renameFolder,
  setFolderCollapsed,
  type ConnectionLayout,
  type LayoutFolder,
} from "../../lib/connectionLayout"
import type { ConnectionConfig } from "../../lib/connections"
import { useConnectionLayout } from "../../state/connectionLayoutStore"
import { isDescendant, TreeChevron, useSchemaTree, useTreeTabIndex } from "../schema"
import { ConnectionRow } from "./ConnectionRow"
import { moveStepItems } from "./layoutMenus"
import { dragAttributes, folderKey, sameRef } from "./layoutTree"
import { useDragState } from "./useLayoutDrag"

const update = (change: (layout: ConnectionLayout) => ConnectionLayout) =>
  useConnectionLayout.getState().update(change)

/** Inline name editor: Enter or leaving the field saves, Escape keeps the old name. */
function RenameInput({
  folder,
  onDone,
}: {
  folder: LayoutFolder
  onDone: (name: string | null) => void
}) {
  const [value, setValue] = useState(folder.name)
  const inputRef = useRef<HTMLInputElement>(null)
  // Finishing moves focus back to the row, which blurs the field; only the first end counts.
  const doneRef = useRef(false)
  useEffect(() => inputRef.current?.select(), [])
  const finish = (name: string | null) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(name)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.code === "Enter" || event.code === "NumpadEnter") {
      event.preventDefault()
      finish(value)
    } else if (event.code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      finish(null)
    }
  }
  return (
    <input
      ref={inputRef}
      className="conn-folder__input"
      aria-label="Folder name"
      value={value}
      autoFocus
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value)}
    />
  )
}

interface FolderRowProps {
  folder: LayoutFolder
  connections: readonly ConnectionConfig[]
  /** Shown open regardless of `collapsed`, while the list is filtered. */
  forceOpen: boolean
  /** Holds the tree's tab stop while no other node does. */
  tabStop?: boolean
}

/** A folder in the connection list: a level 1 treeitem whose group holds its connections. */
export function FolderRow({ folder, connections, forceOpen, tabStop = false }: FolderRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const itemRef = useRef<HTMLLIElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const key = folderKey(folder.id)
  const ref = { type: "folder", id: folder.id } as const
  const tabIndex = useTreeTabIndex(key, tabStop)
  const renaming = useConnectionLayout((s) => s.renaming === folder.id)
  const drop = useDragState((s) => (sameRef(s.over?.ref ?? null, ref) ? s.over?.position : null))
  const dragging = useDragState((s) => sameRef(s.dragging, ref))
  const expanded = forceOpen || !folder.collapsed
  const count = connections.length
  const label = `${folder.name}, folder, ${count} ${count === 1 ? "connection" : "connections"}`

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    const item = itemRef.current
    // Selecting an item or Esc leaves focus in the closing menu; hand it back to the row.
    if (item?.contains(document.activeElement)) item.focus()
  }, [])

  const toggle = () => {
    if (forceOpen) return
    if (expanded) {
      // The tab stop and focus move up from rows the collapse hides.
      const tree = useSchemaTree.getState()
      const hidden = (k: string) => connections.some((c) => k === c.id || isDescendant(k, c.id))
      if (tree.focused !== null && hidden(tree.focused)) tree.setFocused(key)
      const item = itemRef.current
      if (item && item !== document.activeElement && item.contains(document.activeElement)) {
        item.focus()
      }
    }
    update((layout) => setFolderCollapsed(layout, folder.id, expanded))
  }

  const finishRename = (name: string | null) => {
    useConnectionLayout.getState().setRenaming(null)
    if (name !== null) update((layout) => renameFolder(layout, folder.id, name))
    itemRef.current?.focus()
  }

  return (
    <li
      ref={itemRef}
      className="conn-folder"
      role="treeitem"
      aria-level={1}
      aria-label={label}
      aria-expanded={expanded}
      data-tree-key={key}
      tabIndex={tabIndex}
      data-drop={drop ?? undefined}
      data-dragging={dragging || undefined}
    >
      <div className="conn-folder__line" data-menu={menuOpen || undefined} {...dragAttributes(ref)}>
        {forceOpen ? (
          <span className="tree-row__twisty" aria-hidden />
        ) : (
          <TreeChevron expanded={expanded} label={folder.name} onToggle={toggle} />
        )}
        {renaming ? (
          <RenameInput folder={folder} onDone={finishRename} />
        ) : (
          <button
            type="button"
            className="conn-folder__main"
            tabIndex={-1}
            data-tree-action=""
            onClick={toggle}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuOpen(true)
            }}
            title={folder.name}
          >
            {expanded ? (
              <FolderOpen size={14} strokeWidth={1.75} className="conn-folder__icon" aria-hidden />
            ) : (
              <Folder size={14} strokeWidth={1.75} className="conn-folder__icon" aria-hidden />
            )}
            <span className="conn-folder__name">{folder.name}</span>
            <span className="conn-folder__count" aria-hidden>
              {count}
            </span>
          </button>
        )}
        <button
          ref={moreRef}
          type="button"
          className="ui-icon-button conn-folder__more"
          tabIndex={-1}
          data-tree-menu=""
          aria-label={`Actions for folder ${folder.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Ellipsis size={14} strokeWidth={2} />
        </button>
        {menuOpen && (
          <Menu
            label={`Actions for folder ${folder.name}`}
            className="conn-row__menu"
            triggerRef={moreRef}
            onClose={closeMenu}
            items={[
              {
                id: "rename",
                label: "Rename",
                icon: <Pencil size={13} aria-hidden />,
                onSelect: () => useConnectionLayout.getState().setRenaming(folder.id),
              },
              ...moveStepItems(ref),
              {
                id: "delete",
                label: "Delete folder",
                hint: count > 0 ? "Its connections move to the top level" : undefined,
                tone: "danger",
                icon: <Trash size={13} aria-hidden />,
                separatorBefore: true,
                onSelect: () => update((layout) => deleteFolder(layout, folder.id)),
              },
            ]}
          />
        )}
      </div>
      {expanded && count > 0 && (
        <ul role="group" className="tree-group">
          {connections.map((config) => (
            <ConnectionRow key={config.id} config={config} level={2} />
          ))}
        </ul>
      )}
    </li>
  )
}
