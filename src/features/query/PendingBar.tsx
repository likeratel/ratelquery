import { NULL_INPUT } from "../../lib/cellEdit"
import { pendingCount, type GridEdits } from "../../lib/gridEdits"
import { formatShortcut } from "../../lib/shortcuts"
import { useTabsStore } from "../../state/tabsStore"
import { applyActiveEdits } from "./actions"
import { APP_SHORTCUTS } from "./appShortcuts"

interface PendingBarProps {
  tabId: string
  index: number
  edits: GridEdits | undefined
  applying: boolean
}

export function PendingBar({ tabId, index, edits, applying }: PendingBarProps) {
  const discardEdits = useTabsStore((s) => s.discardEdits)
  const count = edits ? pendingCount(edits) : 0
  if (count === 0) return null

  return (
    <div className="pending-bar" role="region" aria-label="Pending changes">
      <span className="pending-bar__count">
        {count} pending {count === 1 ? "change" : "changes"}
      </span>
      <span className="pending-bar__sep">·</span>
      <button
        type="button"
        className="q-button q-button--primary"
        disabled={applying}
        onClick={() => void applyActiveEdits()}
      >
        {applying ? "Applying…" : "Apply"}
        <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.apply)}</kbd>
      </button>
      <span className="pending-bar__sep">·</span>
      <button
        type="button"
        className="q-button q-button--ghost"
        disabled={applying}
        onClick={() => discardEdits(tabId, index)}
      >
        Discard
      </button>
      <span className="pending-bar__hint">
        Type {NULL_INPUT} in a cell for SQL NULL; lowercase null stays text
      </span>
    </div>
  )
}
