import { useState } from "react"
import { pendingCount } from "../../lib/gridEdits"
import type { QueryTab } from "../../lib/queryTabs"
import { formatShortcut } from "../../lib/shortcuts"
import { useTabsStore } from "../../state/tabsStore"
import { applyActiveEdits } from "./actions"
import { APP_SHORTCUTS } from "./appShortcuts"

export function PendingBar({ tab, index }: { tab: QueryTab; index: number }) {
  const discardEdits = useTabsStore((s) => s.discardEdits)
  const [applying, setApplying] = useState(false)
  const edits = tab.edits[index]
  const count = edits ? pendingCount(edits) : 0
  if (count === 0) return null

  const apply = async () => {
    setApplying(true)
    try {
      await applyActiveEdits()
    } finally {
      setApplying(false)
    }
  }

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
        onClick={() => void apply()}
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
    </div>
  )
}
