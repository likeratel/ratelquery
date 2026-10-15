import { NULL_INPUT } from "../../lib/cellEdit"
import { pendingCount } from "../../lib/gridEdits"
import type { QueryTab } from "../../lib/queryTabs"
import { formatShortcut } from "../../lib/shortcuts"
import { useTabsStore } from "../../state/tabsStore"
import { applyActiveEdits } from "./actions"
import { APP_SHORTCUTS } from "./appShortcuts"

export function PendingBar({ tab, index }: { tab: QueryTab; index: number }) {
  const discardEdits = useTabsStore((s) => s.discardEdits)
  const applying = tab.applying
  const edits = tab.edits[index]
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
        onClick={() => discardEdits(tab.id, index)}
      >
        Discard
      </button>
      <span className="pending-bar__hint">
        Type {NULL_INPUT} in a cell for SQL NULL; lowercase null stays text
      </span>
    </div>
  )
}
