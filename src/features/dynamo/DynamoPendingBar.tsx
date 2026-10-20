import { pendingEditCount } from "../../lib/dynamoEdits"
import type { DynamoTab } from "../../lib/dynamoTabs"
import { formatShortcut } from "../../lib/shortcuts"
import { APP_SHORTCUTS } from "../query/appShortcuts"
import { applyDynamoEdits, discardDynamoEdits } from "./actions"

/** Pending inline edits of a DynamoDB tab, with Apply and Discard like the SQL grid's bar. */
export function DynamoPendingBar({ tab }: { tab: DynamoTab }) {
  const count = pendingEditCount(tab.edits)
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
        disabled={tab.applying || tab.running}
        onClick={() => void applyDynamoEdits(tab.id)}
      >
        {tab.applying ? "Applying…" : "Apply"}
        <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.apply)}</kbd>
      </button>
      <span className="pending-bar__sep">·</span>
      <button
        type="button"
        className="q-button q-button--ghost"
        disabled={tab.applying}
        onClick={() => discardDynamoEdits(tab.id)}
      >
        Discard
      </button>
      <span className="pending-bar__hint">
        Keys, NULL, binary, maps, lists and sets are edited in the item editor
      </span>
    </div>
  )
}
