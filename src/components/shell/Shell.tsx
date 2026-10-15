import { useEffect } from "react"
import { handleAppShortcut, QueryWorkspace, Toasts } from "../../features/query"
import { useConnectionsStore } from "../../state/connectionsStore"
import { subscribeSessionEvents } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { applyPlatformAttribute, applyTheme, useUiStore } from "../../state/uiStore"
import { EmptyWorkspace } from "./EmptyWorkspace"
import { Sidebar } from "./Sidebar"
import { StatusBar } from "./StatusBar"
import { TabBar } from "./TabBar"
import "./shell.css"

export function Shell() {
  const theme = useUiStore((s) => s.theme)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const hasTabs = useTabsStore((s) => s.tabs.length > 0)
  const openDialog = useConnectionsStore((s) => s.openDialog)

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => applyPlatformAttribute(), [])

  useEffect(() => subscribeSessionEvents(), [])

  useEffect(() => {
    // The SQL editor handles these in its own capture phase and stops the event, so this
    // listener only sees shortcuts pressed elsewhere in the window.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
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
        <div className="workspace__main">{hasTabs ? <QueryWorkspace /> : <EmptyWorkspace />}</div>
      </div>
      <StatusBar />
      <Toasts />
    </div>
  )
}
