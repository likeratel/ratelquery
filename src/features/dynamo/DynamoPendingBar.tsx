import type { KeySchema } from "../../lib/dynamo"
import {
  CONFLICT_HINT,
  conflictingChanges,
  failedEditHint,
  itemEdit,
  pendingEditCount,
} from "../../lib/dynamoEdits"
import { selectedItem, type DynamoTab } from "../../lib/dynamoTabs"
import { formatShortcut } from "../../lib/shortcuts"
import { APP_SHORTCUTS } from "../query/appShortcuts"
import { applyDynamoEdits, discardDynamoEdits, discardSelectedItemEdits } from "./actions"

const EDITOR_HINT =
  "Nested values are edited in the item tree; keys, NULL, binary, sets and structure in the item editor"

/**
 * Pending inline edits of a DynamoDB tab, with Apply and Discard like the SQL grid's bar. When
 * the selected item has pending edits they can be discarded alone, so an item whose write was
 * refused shows the server's values again without dropping the other changes.
 */
export function DynamoPendingBar({ tab, schema }: { tab: DynamoTab; schema: KeySchema | null }) {
  const count = pendingEditCount(tab.edits)
  if (count === 0) return null
  const item = selectedItem(tab)
  const selectedEdit = item ? itemEdit(tab.edits, item, schema) : undefined
  const conflict = item !== null && conflictingChanges(selectedEdit, item).length > 0
  const warning = selectedEdit?.failed
    ? failedEditHint(selectedEdit.failed)
    : conflict
      ? CONFLICT_HINT
      : null
  const hint = warning ?? EDITOR_HINT

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
      {selectedEdit && (
        <>
          <span className="pending-bar__sep">·</span>
          <button
            type="button"
            className="q-button q-button--ghost"
            disabled={tab.applying}
            onClick={() => discardSelectedItemEdits(tab.id)}
          >
            Discard item
          </button>
        </>
      )}
      {/* The hint is cut to one line; the title carries the whole text. */}
      <span className="pending-bar__hint" role={warning ? "status" : undefined} title={hint}>
        {hint}
      </span>
    </div>
  )
}
