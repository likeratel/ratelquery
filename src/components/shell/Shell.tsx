import { useEffect } from "react"
import { ConnectionDialog } from "../../features/connections"
import { DynamoWorkspace } from "../../features/dynamo"
import { handleAppShortcut, QueryWorkspace, subscribeConnectionCleanup } from "../../features/query"
import { useConnectionsStore } from "../../state/connectionsStore"
import { subscribeSessionEvents } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { applyPlatformAttribute, applyTheme, useUiStore } from "../../state/uiStore"
import { isModalOpen, Toaster } from "../ui"
import { EmptyWorkspace } from "./EmptyWorkspace"
import { Sidebar } from "./Sidebar"
import { StatusBar } from "./StatusBar"
import { TabBar } from "./TabBar"
import "./shell.css"

export function Shell() {
  const theme = useUiStore((s) => s.theme)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const activeKind = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId)?.kind ?? null)
  const openDialog = useConnectionsStore((s) => s.openDialog)

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => applyPlatformAttribute(), [])

  useEffect(() => subscribeSessionEvents(), [])

  useEffect(() => subscribeConnectionCleanup(), [])

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
    <div className="shell" data-sidebar={collapsed ? "collapsed" : "open"}>
      <Sidebar onAddConnection={() => openDialog()} inert={collapsed} />
      <div className="workspace">
        <TabBar />
        <div className="workspace__main">
          {activeKind === "dynamo" ? (
            <DynamoWorkspace />
          ) : activeKind === "query" ? (
            <QueryWorkspace />
          ) : (
            <EmptyWorkspace />
          )}
        </div>
      </div>
      <StatusBar />
      {/* Outside the sidebar, which turns inert when collapsed. */}
      <ConnectionDialog />
      <Toaster />
    </div>
  )
}
