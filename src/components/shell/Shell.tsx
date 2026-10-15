import { useEffect } from "react"
import { matchesShortcut, parseShortcut } from "../../lib/shortcuts"
import { applyTheme, useUiStore } from "../../state/uiStore"
import { EmptyWorkspace } from "./EmptyWorkspace"
import { Sidebar } from "./Sidebar"
import { StatusBar } from "./StatusBar"
import { TabBar } from "./TabBar"
import "./shell.css"

const TOGGLE_SIDEBAR = parseShortcut("Mod+B")

export function Shell() {
  const theme = useUiStore((s) => s.theme)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, TOGGLE_SIDEBAR)) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [toggleSidebar])

  return (
    <div className="shell" data-sidebar={collapsed ? "collapsed" : "open"}>
      <Sidebar onAddConnection={() => {}} />
      <div className="workspace">
        <TabBar />
        <div className="workspace__main">
          <EmptyWorkspace />
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
