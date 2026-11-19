import { PanelLeft } from "lucide-react"
import { APP_SHORTCUTS } from "../../features/query"
import { formatShortcut } from "../../lib/shortcuts"
import { useUiStore } from "../../state/uiStore"

const SHORTCUT_LABEL = formatShortcut(APP_SHORTCUTS.toggleSidebar)

/**
 * Shows or hides the connections sidebar. It sits at the window's top-left, next to the macOS
 * traffic lights, and stays put whether the sidebar is open or not, so a second click undoes the
 * first without moving the pointer. Rendered outside the sidebar, which turns inert when collapsed.
 */
export function SidebarToggle() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const label = collapsed ? "Show sidebar" : "Hide sidebar"
  return (
    <button
      type="button"
      className="ui-icon-button shell__sidebar-toggle"
      data-size="md"
      onClick={toggleSidebar}
      aria-pressed={!collapsed}
      aria-label={label}
      title={`${label} (${SHORTCUT_LABEL})`}
    >
      <PanelLeft size={15} strokeWidth={2} />
    </button>
  )
}
