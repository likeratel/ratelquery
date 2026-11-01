import { Ellipsis, Folder, FolderOpen, FolderPlus, Pencil, Trash } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Menu } from "../../components/ui"
import { isImeComposing } from "../../lib/shortcuts"
import {
  deleteFolder,
  MAX_FOLDER_DEPTH,
  renameFolder,
  setFolderCollapsed,
  type ConnectionLayout,
  type LayoutEntry,
  type LayoutFolder,
} from "../../lib/connectionLayout"
import { useConnectionLayout } from "../../state/connectionLayoutStore"
import { depthStyle, TreeChevron, useSchemaTree, useTreeTabIndex } from "../schema"
import { ConnectionRow } from "./ConnectionRow"
import { moveStepItems, moveToFolderEntry, moveToFolderItems } from "./layoutMenus"
import { dragAttributes, entryKey, folderKey, sameRef, showsNode } from "./layoutTree"
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
    if (isImeComposing(event.nativeEvent)) return
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

type FolderMode = "idle" | "menu" | "move"

interface FolderRowProps {
  folder: LayoutFolder
  /** The rows inside the folder. */
  entries: readonly LayoutEntry[]
  /** Connections in the folder and its subfolders. */
  count: number
  /** aria-level: 1 at the top of the list, one more per folder around it. */
  level: number
  /** Shown open regardless of `collapsed`, while the list is filtered. */
  forceOpen: boolean
  /** Holds the tree's tab stop while no other node does. */
  tabStop?: boolean
}

/** A folder in the connection list: a treeitem whose group holds its connections and folders. */
export function FolderRow({
  folder,
  entries,
  count,
  level,
  forceOpen,
  tabStop = false,
}: FolderRowProps) {
  const [mode, setMode] = useState<FolderMode>("idle")
  const itemRef = useRef<HTMLLIElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const key = folderKey(folder.id)
  const ref = { type: "folder", id: folder.id } as const
  const tabIndex = useTreeTabIndex(key, tabStop)
  const renaming = useConnectionLayout((s) => s.renaming === folder.id)
  const drop = useDragState((s) => (sameRef(s.over?.ref ?? null, ref) ? s.over?.position : null))
  const dragging = useDragState((s) => sameRef(s.dragging, ref))
  const expanded = forceOpen || !folder.collapsed
  const menuOpen = mode !== "idle"
  const label = `${folder.name}, folder, ${count} ${count === 1 ? "connection" : "connections"}`

  const closeMenu = useCallback(() => {
    setMode("idle")
    const item = itemRef.current
    // Selecting an item or Esc leaves focus in the closing menu; hand it back to the row.
    if (item?.contains(document.activeElement)) item.focus()
  }, [])

  const toggle = () => {
    if (forceOpen) return
    if (expanded) {
      // The tab stop and focus move up from rows the collapse hides.
      const tree = useSchemaTree.getState()
      if (tree.focused !== null && showsNode(entries, tree.focused, true)) tree.setFocused(key)
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
      aria-level={level}
      aria-label={label}
      aria-expanded={expanded}
      data-tree-key={key}
      tabIndex={tabIndex}
      data-drop={drop ?? undefined}
      data-dragging={dragging || undefined}
      style={depthStyle(level)}
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
              setMode("menu")
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
          onClick={() => setMode((m) => (m === "idle" ? "menu" : "idle"))}
        >
          <Ellipsis size={14} strokeWidth={2} />
        </button>
        {mode === "move" && (
          <Menu
            label={`Move folder ${folder.name} to folder`}
            itemsLabel="Move to"
            className="conn-row__menu"
            triggerRef={moreRef}
            onClose={closeMenu}
            items={moveToFolderItems(ref)}
          />
        )}
        {mode === "menu" && (
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
              {
                id: "new-subfolder",
                label: "New subfolder",
                icon: <FolderPlus size={13} aria-hidden />,
                // Filtering hides the new, empty folder (and with it the name field).
                disabled: forceOpen || level >= MAX_FOLDER_DEPTH,
                onSelect: () => useConnectionLayout.getState().createFolder(folder.id),
              },
              ...moveStepItems(ref),
              moveToFolderEntry(ref, () => setMode("move")),
              {
                id: "delete",
                label: "Delete folder",
                hint:
                  entries.length === 0
                    ? undefined
                    : level === 1
                      ? "What it holds moves to the top level"
                      : "What it holds moves to the folder above",
                tone: "danger",
                icon: <Trash size={13} aria-hidden />,
                separatorBefore: true,
                onSelect: () => update((layout) => deleteFolder(layout, folder.id)),
              },
            ]}
          />
        )}
      </div>
      {expanded && entries.length > 0 && (
        <ul role="group" className="tree-group">
          {entries.map((entry) => (
            <LayoutEntryRow
              key={entryKey(entry)}
              entry={entry}
              level={level + 1}
              forceOpen={forceOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

interface LayoutEntryRowProps {
  entry: LayoutEntry
  level: number
  forceOpen: boolean
  tabStop?: boolean
}

/** The row of a layout entry: a connection, or a folder with the rows inside it. */
export function LayoutEntryRow({ entry, level, forceOpen, tabStop }: LayoutEntryRowProps) {
  return entry.type === "connection" ? (
    <ConnectionRow config={entry.config} level={level} tabStop={tabStop} />
  ) : (
    <FolderRow
      folder={entry.folder}
      entries={entry.children}
      count={entry.count}
      level={level}
      forceOpen={forceOpen}
      tabStop={tabStop}
    />
  )
}
