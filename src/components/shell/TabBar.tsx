import { Cloud, Database, PanelLeft, Plus, Table2, X, type LucideIcon } from "lucide-react"
import { type CSSProperties, type KeyboardEvent, type MouseEvent } from "react"
import { useShallow } from "zustand/react/shallow"
import { CONNECTION_KIND_ICON, CONNECTION_KIND_LABEL } from "../../features/connections"
import {
  cancelCloseGroup,
  cancelCloseTab,
  closeConnectionTabs,
  closeQueryTab,
  confirmCloseGroup,
  confirmCloseTab,
  newTabFromActive,
} from "../../features/query"
import type { ConnectionId } from "../../lib/connections"
import { hasUnsavedWork, type WorkspaceTab } from "../../lib/queryTabs"
import { activeConnectionId, groupTabIds, tabGroups } from "../../lib/tabGroups"
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

const UNKNOWN_CONNECTION = "Unknown connection"

/** Name, colour and kind of a saved connection, for the tab bar. */
function useConnectionLabel(connectionId: ConnectionId | null | undefined) {
  return useConnectionsStore(
    useShallow((s) => {
      const found = s.connections.find((c) => c.id === connectionId)
      return { name: found?.name, color: found?.color, kind: found?.kind }
    }),
  )
}

/** Inline custom property for the connection colour; the stylesheet falls back to a neutral. */
function connectionColorStyle(color: string | undefined): CSSProperties | undefined {
  return color ? ({ "--conn": color } as CSSProperties) : undefined
}

/**
 * Roving focus over one tab list: arrows and Home/End move between its tabs, Enter or Space
 * activates. `idKey` names the data attribute holding each tab's id.
 */
function rovingKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  ids: readonly string[],
  idKey: "tabId" | "connectionId",
  activate: (id: string) => void,
): void {
  const from = (event.target as HTMLElement).closest<HTMLElement>("[role=tab]")
  if (!from || event.target !== from) return
  const target = tabKeyTarget(ids, from.dataset[idKey] ?? null, event.code)
  if (!target) return
  event.preventDefault()
  if (target.activate) activate(target.id)
  else {
    const attribute = idKey === "tabId" ? "data-tab-id" : "data-connection-id"
    const selector = `[${attribute}="${CSS.escape(target.id)}"]`
    event.currentTarget.querySelector<HTMLElement>(selector)?.focus()
  }
}

function ConnectionTabItem({
  connectionId,
  active,
}: {
  connectionId: ConnectionId
  active: boolean
}) {
  const activateConnection = useTabsStore((s) => s.activateConnection)
  const count = useTabsStore((s) => s.tabs.filter((t) => t.connectionId === connectionId).length)
  const connection = useConnectionLabel(connectionId)
  const name = connection.name ?? UNKNOWN_CONNECTION
  const KindIcon = connection.kind ? CONNECTION_KIND_ICON[connection.kind] : Database
  const kindLabel = connection.kind ? CONNECTION_KIND_LABEL[connection.kind] : undefined
  const tabsLabel = `${count} ${count === 1 ? "tab" : "tabs"}`

  return (
    <div
      className="conn-tab"
      role="tab"
      aria-selected={active}
      aria-label={`${name}, ${tabsLabel}`}
      tabIndex={active ? 0 : -1}
      data-connection-id={connectionId}
      title={[name, kindLabel, tabsLabel].filter(Boolean).join(" · ")}
      style={connectionColorStyle(connection.color)}
      onMouseDown={(event) => {
        if (event.button === MIDDLE_BUTTON) event.preventDefault()
        else if (event.button === 0) activateConnection(connectionId)
      }}
      onAuxClick={(event: MouseEvent) => {
        if (event.button === MIDDLE_BUTTON) {
          event.preventDefault()
          closeConnectionTabs(connectionId)
        }
      }}
    >
      <KindIcon size={13} strokeWidth={1.9} className="conn-tab__kind" aria-hidden />
      <span className="conn-tab__name">{name}</span>
      <span className="conn-tab__count" aria-hidden>
        {count}
      </span>
      <button
        type="button"
        className="tab__close conn-tab__close"
        aria-label={`Close all tabs on ${name}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => closeConnectionTabs(connectionId)}
      >
        <X size={12} strokeWidth={2.2} />
      </button>
    </div>
  )
}

function TabItem({ id, active }: { id: string; active: boolean }) {
  const activate = useTabsStore((s) => s.activate)
  const tab = useTabsStore(useShallow((s) => selectTabSummary(s, id)))
  const connection = useConnectionLabel(tab?.connectionId)
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

/** One confirmation for closing every tab of a connection when some hold unsaved work. */
function CloseGroupDialog() {
  const connectionId = useTabsStore((s) => s.closingGroup)
  const counts = useTabsStore(
    useShallow((s) => {
      const tabs = s.tabs.filter((t) => t.connectionId === s.closingGroup)
      return { total: tabs.length, unsaved: tabs.filter(hasUnsavedWork).length }
    }),
  )
  const connection = useConnectionLabel(connectionId)
  if (!connectionId || counts.total === 0) return null
  const name = connection.name ?? UNKNOWN_CONNECTION
  const tabs = counts.total === 1 ? "tab" : `${counts.total} tabs`
  const unsaved =
    counts.total === 1
      ? "It holds"
      : counts.unsaved === 1
        ? "One of them holds"
        : `${counts.unsaved} of them hold`
  return (
    <Dialog
      title={`Close ${counts.total === 1 ? "the" : "all"} ${tabs} on ${name}?`}
      onClose={cancelCloseGroup}
      footer={
        <>
          <Button variant="ghost" onClick={cancelCloseGroup} autoFocus>
            Keep open
          </Button>
          <Button variant="danger" onClick={confirmCloseGroup}>
            Close {counts.total === 1 ? "tab" : "tabs"}
          </Button>
        </>
      }
    >
      {unsaved} unsaved work (pending grid changes or item editor text) that will be lost.
    </Dialog>
  )
}

/** Top row: one tab per connection with open tabs, in the colour of the connection. */
function ConnectionTabs({ activeConnection }: { activeConnection: ConnectionId | null }) {
  const connectionIds = useTabsStore(
    useShallow((s) => tabGroups(s.tabs).map((g) => g.connectionId)),
  )
  const activateConnection = useTabsStore((s) => s.activateConnection)
  return (
    <div
      className="tabbar__tabs tabbar__connections"
      role="tablist"
      aria-label="Connections"
      onKeyDown={(event) => rovingKeyDown(event, connectionIds, "connectionId", activateConnection)}
    >
      {connectionIds.map((connectionId) => (
        <ConnectionTabItem
          key={connectionId}
          connectionId={connectionId}
          active={connectionId === activeConnection}
        />
      ))}
    </div>
  )
}

/** Second row: the tabs of the active connection only. */
function GroupTabs({ connectionId }: { connectionId: ConnectionId }) {
  const ids = useTabsStore(useShallow((s) => groupTabIds(s.tabs, connectionId)))
  const activeId = useTabsStore((s) => s.activeId)
  const activate = useTabsStore((s) => s.activate)
  const connection = useConnectionLabel(connectionId)
  return (
    <div className="tabbar__row tabbar__row--tabs" style={connectionColorStyle(connection.color)}>
      <div
        className="tabbar__tabs"
        role="tablist"
        aria-label={`Tabs in ${connection.name ?? UNKNOWN_CONNECTION}`}
        onKeyDown={(event) => rovingKeyDown(event, ids, "tabId", activate)}
      >
        {ids.map((id) => (
          <TabItem key={id} id={id} active={id === activeId} />
        ))}
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
      </div>
      <div className="tabbar__spacer" data-tauri-drag-region />
    </div>
  )
}

export function TabBar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const activeConnection = useTabsStore(activeConnectionId)

  return (
    <div className="tabbar">
      <div className="tabbar__row tabbar__row--connections" data-tauri-drag-region>
        <ConnectionTabs activeConnection={activeConnection} />
        <div className="tabbar__spacer" data-tauri-drag-region />
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
      </div>
      {activeConnection && <GroupTabs connectionId={activeConnection} />}
      <CloseTabDialog />
      <CloseGroupDialog />
    </div>
  )
}
