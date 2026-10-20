import { Cloud, Database, PanelLeft, Plus, Table2, X, type LucideIcon } from "lucide-react"
import { useRef, type KeyboardEvent, type MouseEvent } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  cancelCloseTab,
  closeQueryTab,
  confirmCloseTab,
  newTabFromActive,
} from "../../features/query"
import type { WorkspaceTab } from "../../lib/queryTabs"
import { selectTabSummary } from "../../lib/tabViews"
import { tabKeyTarget } from "./tabKeyboard"
import { Button, Dialog } from "../ui"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"

const MIDDLE_BUTTON = 1

const KIND_LABEL: Record<WorkspaceTab["kind"], string> = {
  query: "SQL",
  dynamo: "DynamoDB",
  table: "Table",
}

const KIND_ICON: Record<WorkspaceTab["kind"], LucideIcon> = {
  query: Database,
  dynamo: Cloud,
  table: Table2,
}

function TabItem({ id, active }: { id: string; active: boolean }) {
  const activate = useTabsStore((s) => s.activate)
  const tab = useTabsStore(useShallow((s) => selectTabSummary(s, id)))
  const connection = useConnectionsStore(
    useShallow((s) => {
      const found = s.connections.find((c) => c.id === tab?.connectionId)
      return { name: found?.name, color: found?.color }
    }),
  )
  if (!tab) return null
  const dirty = tab.dirty
  const KindIcon = KIND_ICON[tab.kind]

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
      data-tab-id={tab.id}
      title={[tab.longName, KIND_LABEL[tab.kind], connection.name].filter(Boolean).join(" · ")}
      onMouseDown={(event) => {
        if (event.button === MIDDLE_BUTTON) event.preventDefault()
        else if (event.button === 0) activate(tab.id)
      }}
      onAuxClick={onAuxClick}
    >
      <span
        className="tab__color"
        style={connection.color ? { background: connection.color } : undefined}
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
  dynamo: "Its unsaved item editor text or pending grid changes will be lost.",
  // Table tabs hold no unsaved work, so they never ask.
  table: "",
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
  const ids = useTabsStore(useShallow((s) => s.tabs.map((t) => t.id)))
  const activeId = useTabsStore((s) => s.activeId)
  const listRef = useRef<HTMLDivElement>(null)

  /** Roving focus: arrows and Home/End move between tabs, Enter or Space activates. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = (event.target as HTMLElement).closest<HTMLElement>("[role=tab]")
    if (!from || event.target !== from) return
    const target = tabKeyTarget(ids, from.dataset.tabId ?? null, event.code)
    if (!target) return
    event.preventDefault()
    if (target.activate) useTabsStore.getState().activate(target.id)
    else {
      const selector = `[data-tab-id="${CSS.escape(target.id)}"]`
      listRef.current?.querySelector<HTMLElement>(selector)?.focus()
    }
  }

  return (
    <div className="tabbar" data-tauri-drag-region>
      <div
        className="tabbar__tabs"
        role="tablist"
        aria-label="Tabs"
        ref={listRef}
        onKeyDown={onKeyDown}
      >
        {ids.map((id) => (
          <TabItem key={id} id={id} active={id === activeId} />
        ))}
        {ids.length > 0 && (
          <button
            type="button"
            className="ui-icon-button tabbar__new"
            data-size="md"
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
          className="ui-icon-button"
          data-size="md"
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
