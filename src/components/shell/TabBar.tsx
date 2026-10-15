import { Cloud, Database, PanelLeft, Plus, X } from "lucide-react"
import type { MouseEvent } from "react"
import {
  cancelCloseTab,
  closeQueryTab,
  confirmCloseTab,
  newTabFromActive,
} from "../../features/query"
import { isWorkspaceTabDirty, type WorkspaceTab } from "../../lib/queryTabs"
import { Button, Dialog } from "../ui"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"

const MIDDLE_BUTTON = 1

const KIND_LABEL: Record<WorkspaceTab["kind"], string> = { query: "SQL", dynamo: "DynamoDB" }

function TabItem({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const activate = useTabsStore((s) => s.activate)
  const connection = useConnectionsStore((s) =>
    s.connections.find((c) => c.id === tab.connectionId),
  )
  const dirty = isWorkspaceTabDirty(tab)
  const KindIcon = tab.kind === "dynamo" ? Cloud : Database

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
      title={[tab.title, KIND_LABEL[tab.kind], connection?.name].filter(Boolean).join(" · ")}
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
      <KindIcon
        size={12}
        strokeWidth={1.9}
        className="tab__kind"
        aria-label={KIND_LABEL[tab.kind]}
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

const UNSAVED_DETAIL: Record<WorkspaceTab["kind"], string> = {
  query: "Its pending grid changes haven't been applied and will be lost.",
  dynamo: "Its item editor has unsaved changes that will be lost.",
}

/** Confirmation for closing a tab that holds unsaved work. */
function CloseTabDialog() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.closing) ?? null)
  if (!tab) return null
  return (
    <Dialog
      title={`Close ${tab.title}?`}
      onClose={cancelCloseTab}
      footer={
        <>
          <Button variant="ghost" onClick={cancelCloseTab} autoFocus>
            Keep open
          </Button>
          <Button variant="danger" onClick={confirmCloseTab}>
            Close tab
          </Button>
        </>
      }
    >
      {UNSAVED_DETAIL[tab.kind]}
    </Dialog>
  )
}

export function TabBar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="tabbar__tabs" role="tablist" aria-label="Tabs">
        {tabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} active={tab.id === activeId} />
        ))}
        {tabs.length > 0 && (
          <button
            type="button"
            className="icon-button tabbar__new"
            onClick={newTabFromActive}
            aria-label="New tab"
            title="New tab on the same connection"
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
      <CloseTabDialog />
    </div>
  )
}
