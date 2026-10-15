import { PanelLeft, Plus, X } from "lucide-react"
import type { MouseEvent } from "react"
import { closeQueryTab, newTabFromActive } from "../../features/query"
import { isTabDirty, type QueryTab } from "../../lib/queryTabs"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"

const MIDDLE_BUTTON = 1

function TabItem({ tab, active }: { tab: QueryTab; active: boolean }) {
  const activate = useTabsStore((s) => s.activate)
  const connection = useConnectionsStore((s) =>
    s.connections.find((c) => c.id === tab.connectionId),
  )
  const dirty = isTabDirty(tab)

  const onAuxClick = (event: MouseEvent) => {
    if (event.button === MIDDLE_BUTTON) {
      event.preventDefault()
      closeQueryTab(tab.id)
    }
  }

  return (
    <div
      className="tab"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={connection ? `${tab.title} · ${connection.name}` : tab.title}
      onMouseDown={(event) => {
        if (event.button === MIDDLE_BUTTON) event.preventDefault()
        else if (event.button === 0) activate(tab.id)
      }}
      onAuxClick={onAuxClick}
    >
      <span
        className="tab__color"
        style={connection?.color ? { background: connection.color } : undefined}
      />
      <span className="tab__title">{tab.title}</span>
      <span className="tab__trail" data-dirty={dirty || undefined}>
        {dirty && <span className="tab__dirty" aria-label="Unsaved changes" />}
        <button
          type="button"
          className="tab__close"
          aria-label={`Close ${tab.title}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => closeQueryTab(tab.id)}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </span>
    </div>
  )
}

export function TabBar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="tabbar__tabs" role="tablist" aria-label="Query tabs">
        {tabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} active={tab.id === activeId} />
        ))}
        {tabs.length > 0 && (
          <button
            type="button"
            className="icon-button tabbar__new"
            onClick={newTabFromActive}
            aria-label="New query tab"
            title="New query tab"
          >
            <Plus size={14} strokeWidth={2} />
          </button>
        )}
      </div>
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
