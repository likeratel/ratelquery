import { ArrowDown, ArrowUp, Folder, FolderInput, FolderOutput } from "lucide-react"
import type { MenuItem } from "../../components/ui"
import {
  folderOf,
  moveStep,
  moveToFolder,
  type ConnectionLayout,
  type LayoutRef,
} from "../../lib/connectionLayout"
import type { ConnectionId } from "../../lib/connections"
import { currentLayout, useConnectionLayout } from "../../state/connectionLayoutStore"

const update = (change: (layout: ConnectionLayout) => ConnectionLayout) =>
  useConnectionLayout.getState().update(change)

/** "Move up" and "Move down", disabled where the item can't move that way. */
export function moveStepItems(ref: LayoutRef): MenuItem[] {
  const layout = currentLayout()
  const step = (id: string, label: string, delta: -1 | 1, icon: MenuItem["icon"]): MenuItem => ({
    id,
    label,
    icon,
    disabled: moveStep(layout, ref, delta) === layout,
    onSelect: () => update((current) => moveStep(current, ref, delta)),
  })
  return [
    { ...step("move-up", "Move up", -1, <ArrowUp size={13} aria-hidden />), separatorBefore: true },
    step("move-down", "Move down", 1, <ArrowDown size={13} aria-hidden />),
  ]
}

/** "Top level" and every folder, the connection's current place disabled. */
export function moveToFolderItems(id: ConnectionId): MenuItem[] {
  const layout = currentLayout()
  const current = folderOf(layout, id)
  const topLevel: MenuItem = {
    id: "top-level",
    label: "Top level",
    icon: <FolderOutput size={13} aria-hidden />,
    disabled: current === null,
    onSelect: () => update((l) => moveToFolder(l, id, null)),
  }
  const folders = layout.folders.map((folder): MenuItem => ({
    id: `folder-${folder.id}`,
    label: folder.name,
    icon: <Folder size={13} aria-hidden />,
    disabled: current === folder.id,
    onSelect: () => update((l) => moveToFolder(l, id, folder.id)),
  }))
  return [topLevel, ...folders]
}

/** Opens the folder picker; disabled while there is no folder to move into or out of. */
export function moveToFolderEntry(id: ConnectionId, open: () => void): MenuItem {
  const layout = currentLayout()
  return {
    id: "move-to-folder",
    label: "Move to folder…",
    icon: <FolderInput size={13} aria-hidden />,
    disabled: layout.folders.length === 0 && folderOf(layout, id) === null,
    onSelect: open,
  }
}
