import { FolderPlus, Plus } from "lucide-react"
import { useEffect } from "react"
import { ConnectionList, NEW_CONNECTION_SHORTCUT } from "../../features/connections"
import { formatShortcut } from "../../lib/shortcuts"
import { useConnectionLayout } from "../../state/connectionLayoutStore"
import { useConnectionsStore } from "../../state/connectionsStore"

interface SidebarProps {
  /** Optional extra callback; the dialog itself is opened through the connections store. */
  onAddConnection?: () => void
  /** True while the sidebar is collapsed, so hidden controls leave the tab order. */
  inert?: boolean
}

const ADD_LABEL = `Add connection (${formatShortcut(NEW_CONNECTION_SHORTCUT)})`

export function Sidebar({ onAddConnection, inert = false }: SidebarProps) {
  // The store ignores layout changes until the saved layout has loaded; the list itself (and
  // with it every other layout action) isn't rendered until then either.
  const layoutLoading = useConnectionLayout((s) => s.status === "loading")
  useEffect(() => {
    const { status, load } = useConnectionsStore.getState()
    if (status === "idle") void load()
    const layout = useConnectionLayout.getState()
    if (layout.status === "idle") void layout.load()
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
        <span className="conn-header-actions">
          <button
            type="button"
            className="ui-icon-button"
            data-size="md"
            onClick={() => useConnectionLayout.getState().createFolder()}
            disabled={layoutLoading}
            aria-label="New folder"
            title="New folder"
          >
            <FolderPlus size={15} strokeWidth={2} />
          </button>
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
        </span>
      </div>
      <div className="sidebar__body">
        <ConnectionList />
      </div>
    </aside>
  )
}
