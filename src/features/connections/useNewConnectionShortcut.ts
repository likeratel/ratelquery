import { useEffect } from "react"
import { matchesShortcut, parseShortcut } from "../../lib/shortcuts"
import { useConnectionsStore } from "../../state/connectionsStore"

export const NEW_CONNECTION_SHORTCUT = parseShortcut("Mod+N")

/** Registers Mod+N (physical key) to open the new connection dialog. */
export function useNewConnectionShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !matchesShortcut(event, NEW_CONNECTION_SHORTCUT)) return
      event.preventDefault()
      const { dialog, openDialog } = useConnectionsStore.getState()
      if (!dialog.open) openDialog()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
