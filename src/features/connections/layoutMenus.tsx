import { ArrowDown, ArrowUp, Folder, FolderInput, FolderOutput } from "lucide-react"
import type { MenuItem } from "../../components/ui"
import {
  folderPaths,
  moveStep,
  moveTargets,
  moveToFolder,
  type ConnectionLayout,
  type LayoutRef,
} from "../../lib/connectionLayout"
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

/**
 * "Top level" and every folder, labelled with its path. Where `ref` already is, and for a folder
 * itself and its subfolders, the entry is disabled (see `moveTargets`).
 */
export function moveToFolderItems(ref: LayoutRef): MenuItem[] {
  const layout = currentLayout()
  const names = new Map(
    folderPaths(layout).map(({ folder, names }) => [folder.id, names.join(" › ")]),
  )
  return moveTargets(layout, ref).map(({ folderId, disabled }): MenuItem =>
    folderId === null
      ? {
          id: "top-level",
          label: "Top level",
          icon: <FolderOutput size={13} aria-hidden />,
          disabled,
          onSelect: () => update((l) => moveToFolder(l, ref, null)),
        }
      : {
          id: `folder-${folderId}`,
          label: names.get(folderId) ?? "",
          icon: <Folder size={13} aria-hidden />,
          disabled,
          onSelect: () => update((l) => moveToFolder(l, ref, folderId)),
        },
  )
}

/** Opens the folder picker; disabled while there is nowhere to move `ref` to. */
export function moveToFolderEntry(ref: LayoutRef, open: () => void): MenuItem {
  return {
    id: "move-to-folder",
    label: "Move to folder…",
    icon: <FolderInput size={13} aria-hidden />,
    disabled: moveTargets(currentLayout(), ref).every((target) => target.disabled),
    onSelect: open,
  }
}
