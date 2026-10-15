import { useEffect } from "react"
import { isModalOpen } from "../../components/ui"
import { isMac, matchesShortcut, parseShortcut, type KeyLike } from "../../lib/shortcuts"
import { useConnectionsStore } from "../../state/connectionsStore"

export const NEW_CONNECTION_SHORTCUT = parseShortcut("Mod+N")

type NewConnectionEvent = KeyLike & { isComposing: boolean; defaultPrevented: boolean }

/**
 * What Mod+N does: `ignore` keys that aren't the shortcut, belong to an IME composition, were
 * already handled (an editor claimed them) or repeat; `swallow` the shortcut while a modal is
 * open, since the page behind it is inert; otherwise `open` the dialog.
 */
export function newConnectionAction(
  event: NewConnectionEvent,
  modalOpen: boolean,
  mac = isMac(),
): "ignore" | "swallow" | "open" {
  if (event.isComposing || event.defaultPrevented || event.repeat) return "ignore"
  if (!matchesShortcut(event, NEW_CONNECTION_SHORTCUT, mac)) return "ignore"
  return modalOpen ? "swallow" : "open"
}

/** Registers Mod+N (physical key) to open the new connection dialog. */
export function useNewConnectionShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = newConnectionAction(event, isModalOpen())
      if (action === "ignore") return
      event.preventDefault()
      const { dialog, openDialog } = useConnectionsStore.getState()
      if (action === "open" && !dialog.open) openDialog()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
