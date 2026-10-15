import { Plus } from "lucide-react"
import { useEffect } from "react"
import { ConnectionList, NEW_CONNECTION_SHORTCUT } from "../../features/connections"
import { formatShortcut } from "../../lib/shortcuts"
import { useConnectionsStore } from "../../state/connectionsStore"

interface SidebarProps {
  /** Optional extra callback; the dialog itself is opened through the connections store. */
  onAddConnection?: () => void
  /** True while the sidebar is collapsed, so hidden controls leave the tab order. */
  inert?: boolean
}

const ADD_LABEL = `Add connection (${formatShortcut(NEW_CONNECTION_SHORTCUT)})`

export function Sidebar({ onAddConnection, inert = false }: SidebarProps) {
  useEffect(() => {
    const { status, load } = useConnectionsStore.getState()
    if (status === "idle") void load()
  }, [])

  const onAdd = () => {
    useConnectionsStore.getState().openDialog()
    onAddConnection?.()
  }

  return (
    <aside className="sidebar" aria-label="Connections" inert={inert}>
      <div className="sidebar__drag" data-tauri-drag-region />
      <div className="sidebar__header">
        <span className="sidebar__title">Connections</span>
        <button
          type="button"
          className="ui-icon-button"
          data-size="md"
          onClick={onAdd}
          aria-label="Add connection"
          title={ADD_LABEL}
        >
          <Plus size={15} strokeWidth={2} />
        </button>
      </div>
      <div className="sidebar__body">
        <ConnectionList />
      </div>
    </aside>
  )
}
