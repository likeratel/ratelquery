import { useEffect, useState, type CSSProperties } from "react"
import {
  ConnectionDialog,
  HostKeyPromptDialog,
  PasswordPromptDialog,
  useNewConnectionShortcut,
} from "../../features/connections"
import { DynamoWorkspace } from "../../features/dynamo"
import { subscribeTreeCleanup, TableWorkspace } from "../../features/schema"
import {
  handleAppShortcut,
  QueryWorkspace,
  RunConfirmDialog,
  subscribeConnectionCleanup,
} from "../../features/query"
import { SettingsDialog } from "../../features/settings"
import { useConnectionsStore } from "../../state/connectionsStore"
import { ensureQueryOutputSync } from "../../state/queryOutputSync"
import { subscribeSessionEvents } from "../../state/sessionsStore"
import { applyEditorFontSize, useSettingsStore } from "../../state/settingsStore"
import { useTabsStore } from "../../state/tabsStore"
import { applyPlatformAttribute, applyTheme, useUiStore } from "../../state/uiStore"
import { startWorkspaceSync } from "../../state/workspaceSync"
import { PANEL_SPECS } from "../../lib/panelWidths"
import { isModalOpen, ResizeHandle, Toaster } from "../ui"
import { EmptyWorkspace } from "./EmptyWorkspace"
import { Sidebar } from "./Sidebar"
import { TabBar } from "./TabBar"
import "./shell.css"

export function Shell() {
  const theme = useSettingsStore((s) => s.settings.theme)
  const editorFontSize = useSettingsStore((s) => s.settings.editorFontSize)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useUiStore((s) => s.panelWidths.sidebar)
  const setPanelWidth = useUiStore((s) => s.setPanelWidth)
  const [resizing, setResizing] = useState(false)
  const activeKind = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId)?.kind ?? null)
  const openDialog = useConnectionsStore((s) => s.openDialog)

  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => applyEditorFontSize(editorFontSize), [editorFontSize])

  useEffect(() => applyPlatformAttribute(), [])

  // App-wide subscriptions and listeners live here, mounted once for the whole window.
  useNewConnectionShortcut()

  useEffect(() => subscribeSessionEvents(), [])

  useEffect(() => subscribeConnectionCleanup(), [])

  useEffect(() => subscribeTreeCleanup(), [])

  // Reopens the last session's query tabs once the connection list has loaded, then keeps
  // `workspace.json` up to date. No connection is opened for them.
  useEffect(() => startWorkspaceSync(), [])

  // Loads the saved Output log once settings and connections are ready, then keeps
  // `query-output.json` up to date until the window closes. Starting it again does nothing.
  useEffect(() => ensureQueryOutputSync(), [])

  useEffect(() => {
    // The SQL editor handles these in its own capture phase and stops the event, so this
    // listener only sees shortcuts pressed elsewhere in the window. While a modal dialog is
    // open the page behind it is inert, so its shortcuts must not fire either (Esc belongs to
    // the dialog and isn't an app shortcut).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.code !== "Escape" && isModalOpen()) return
      if (handleAppShortcut(event)) event.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div
      className="shell"
      data-sidebar={collapsed ? "collapsed" : "open"}
      data-resizing={resizing || undefined}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <Sidebar onAddConnection={() => openDialog()} inert={collapsed} />
      {/* Not rendered while collapsed, so it can't be focused or dragged. */}
      {!collapsed && (
        <ResizeHandle
          className="shell__resize"
          width={sidebarWidth}
          spec={PANEL_SPECS.sidebar}
          edge="end"
          label="Resize connections sidebar"
          onResize={(width, settled) => setPanelWidth("sidebar", width, settled)}
          onDragChange={setResizing}
        />
      )}
      <div className="workspace">
        <TabBar />
        <div className="workspace__main">
          {activeKind === "dynamo" ? (
            <DynamoWorkspace />
          ) : activeKind === "table" ? (
            <TableWorkspace />
          ) : activeKind === "query" ? (
            <QueryWorkspace />
          ) : (
            <EmptyWorkspace />
          )}
        </div>
      </div>
      {/* Outside the sidebar, which turns inert when collapsed. */}
      <ConnectionDialog />
      <SettingsDialog />
      <RunConfirmDialog />
      <PasswordPromptDialog />
      <HostKeyPromptDialog />
      <Toaster />
    </div>
  )
}
