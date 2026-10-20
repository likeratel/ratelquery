import { Copy, Pencil, Trash } from "lucide-react"
import type { RefObject } from "react"
import { Menu, showToast } from "../../components/ui"
import { placeAfter } from "../../lib/connectionLayout"
import type { ConnectionConfig } from "../../lib/connections"
import { useConnectionLayout } from "../../state/connectionLayoutStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { moveStepItems, moveToFolderEntry, moveToFolderItems } from "./layoutMenus"

/** Saves a copy (secrets copied by the backend) and lists it right after the original. */
async function duplicate(config: ConnectionConfig): Promise<void> {
  const result = await useConnectionsStore.getState().duplicate(config.id)
  if (!result.ok) {
    showToast({ tone: "error", message: result.error.summary, detail: result.error.detail })
    return
  }
  useConnectionLayout.getState().update((layout) => placeAfter(layout, result.value.id, config.id))
}

interface ConnectionMenuProps {
  config: ConnectionConfig
  /** `actions` is the row's "…" menu; `move` the folder picker it opens. */
  kind: "actions" | "move"
  triggerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onMove: () => void
  onDelete: () => void
}

export function ConnectionMenu({
  config,
  kind,
  triggerRef,
  onClose,
  onMove,
  onDelete,
}: ConnectionMenuProps) {
  if (kind === "move") {
    return (
      <Menu
        label={`Move ${config.name} to folder`}
        itemsLabel="Move to"
        className="conn-row__menu"
        triggerRef={triggerRef}
        onClose={onClose}
        items={moveToFolderItems(config.id)}
      />
    )
  }
  return (
    <Menu
      label={`Actions for ${config.name}`}
      className="conn-row__menu"
      triggerRef={triggerRef}
      onClose={onClose}
      items={[
        {
          id: "edit",
          label: "Edit",
          icon: <Pencil size={13} aria-hidden />,
          onSelect: () => useConnectionsStore.getState().openDialog(config),
        },
        {
          id: "duplicate",
          label: "Duplicate",
          icon: <Copy size={13} aria-hidden />,
          onSelect: () => void duplicate(config),
        },
        ...moveStepItems({ type: "connection", id: config.id }),
        moveToFolderEntry(config.id, onMove),
        {
          id: "delete",
          label: "Delete",
          tone: "danger",
          icon: <Trash size={13} aria-hidden />,
          separatorBefore: true,
          onSelect: onDelete,
        },
      ]}
    />
  )
}
