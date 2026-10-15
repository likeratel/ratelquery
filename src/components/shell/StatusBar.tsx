import { useEffect, useState } from "react"
import { ipc } from "../../lib/ipc"

interface AppInfo {
  name: string
  version: string
}

export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    ipc<AppInfo>("app_info")
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => {
        /* Outside Tauri (plain browser dev) there is no backend; leave the version blank. */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        <span className="dot" data-state="idle" />
        Not connected
      </span>
      <span className="statusbar__spacer" />
      {info && <span className="statusbar__item">v{info.version}</span>}
    </footer>
  )
}
