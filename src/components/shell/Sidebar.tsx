import { Plus } from "lucide-react"

interface SidebarProps {
  onAddConnection: () => void
}

export function Sidebar({ onAddConnection }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Connections">
      <div className="sidebar__drag" />
      <div className="sidebar__header">
        <span className="sidebar__title">Connections</span>
        <button
          type="button"
          className="icon-button"
          onClick={onAddConnection}
          aria-label="Add connection"
          title="Add connection"
        >
          <Plus size={15} strokeWidth={2} />
        </button>
      </div>
      <div className="sidebar__body">
        <div className="sidebar__empty">
          <strong>No connections yet</strong>
          Add a MySQL server or a DynamoDB profile to start browsing.
        </div>
      </div>
    </aside>
  )
}
