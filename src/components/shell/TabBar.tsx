import { PanelLeft } from "lucide-react"
import { useUiStore } from "../../state/uiStore"

export function TabBar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  return (
    <div className="tabbar">
      <div className="tabbar__tabs" role="tablist" />
      <div className="tabbar__spacer" />
      <div className="tabbar__actions">
        <button
          type="button"
          className="icon-button"
          onClick={toggleSidebar}
          aria-pressed={!collapsed}
          aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
          title={collapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <PanelLeft size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
