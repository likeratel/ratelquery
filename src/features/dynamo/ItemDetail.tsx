import { Pencil, X } from "lucide-react"
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { JsonEditor } from "../../components/editor/lazyEditors"
import { SegmentedControl } from "../../components/ui"
import type { Item, KeySchema } from "../../lib/dynamo"
import { itemKey } from "../../lib/dynamoDiff"
import {
  CONFLICT_HINT,
  conflictingChanges,
  failedEditHint,
  itemEdit,
  keyId,
  pendingChangeList,
  withPendingValues,
  type PendingItemEdit,
} from "../../lib/dynamoEdits"
import { findLossyAttributes, formatItem, type JsonMode } from "../../lib/dynamoJson"
import { jsonModeFor, type DetailView, type DynamoTab } from "../../lib/dynamoTabs"
import { formatShortcut, matchesShortcut } from "../../lib/shortcuts"
import { APP_SHORTCUTS } from "../query/appShortcuts"
import {
  applyFromPanel,
  applySelectedItemEdits,
  cancelItemReview,
  discardSelectedItemEdits,
  reviewSelectedItemEdits,
  setDetailView,
  setPanelJsonMode,
} from "./actions"
import { DiffList } from "./DiffList"
import { ItemTree } from "./ItemTree"
import { DYNAMO_SHORTCUTS } from "./shortcuts"

const VIEW_OPTIONS = [
  { value: "tree", label: "Tree" },
  { value: "json", label: "JSON" },
] as const

const changes = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`

/** Read-only JSON of the item in the mode the editor would open in. */
function ItemJson({ tab, item, schema }: { tab: DynamoTab; item: Item; schema: KeySchema | null }) {
  const mode = jsonModeFor(item, tab.panel.mode, schema)
  const lossy = findLossyAttributes(item)
  const plainReason = lossy.length > 0 ? `${lossy[0].path}: ${lossy[0].reason}` : null
  const modeOptions = [
    {
      value: "plain" as JsonMode,
      label: "Plain",
      disabled: mode === "wire" && plainReason !== null,
    },
    { value: "wire" as JsonMode, label: "Wire" },
  ]
  return (
    <>
      <div className="dyn-tree__bar">
        <div className="dyn-compact" title={plainReason ?? undefined}>
          <SegmentedControl<JsonMode>
            label="JSON format"
            value={mode}
            options={modeOptions}
            onChange={(next) => setPanelJsonMode(tab.id, next)}
          />
        </div>
      </div>
      {plainReason && (
        <p className="dyn-note">
          Plain mode is off: {plainReason}
          {lossy.length > 1 ? ` (and ${lossy.length - 1} more)` : ""}.
        </p>
      )}
      <div className="dyn-editor__code">
        <JsonEditor
          value={formatItem(item, mode)}
          onChange={() => {}}
          readOnly
          ariaLabel="Item JSON"
        />
      </div>
    </>
  )
}

interface PendingProps {
  tab: DynamoTab
  edit: PendingItemEdit
  /** Changes the item as loaded now no longer matches. */
  conflicts: number
}

/** The selected item's pending changes, listed like the editor's review before writing. */
function Review({ tab, edit, conflicts }: PendingProps) {
  const applyRef = useRef<HTMLButtonElement>(null)
  useEffect(() => applyRef.current?.focus(), [])
  const list = pendingChangeList(edit)
  return (
    <div className="dyn-editor__review">
      <p className="dyn-editor__summary">
        {changes(list.length)} · saves only if each edited value, and each list on its path, is
        still what was loaded
      </p>
      {conflicts > 0 && <p className="dyn-note dyn-note--warn">{CONFLICT_HINT}</p>}
      <DiffList changes={list} />
      <footer className="dyn-side__foot">
        <button
          type="button"
          className="q-button q-button--ghost"
          disabled={tab.applying}
          onClick={() => cancelItemReview(tab.id)}
        >
          Back
        </button>
        <span className="dyn-side__spacer" />
        <button
          ref={applyRef}
          type="button"
          className="q-button q-button--primary"
          disabled={tab.applying || tab.running}
          onClick={() => void applySelectedItemEdits(tab.id)}
        >
          {tab.applying ? "Applying…" : "Apply"}
        </button>
      </footer>
    </div>
  )
}

/** Apply and Discard for the selected item's pending changes, from the tree or the grid. */
function PendingFoot({ tab, edit, conflicts }: PendingProps) {
  const count = Object.keys(edit.changes).length
  const hint = edit.failed ? failedEditHint(edit.failed) : conflicts > 0 ? CONFLICT_HINT : null
  return (
    <>
      {hint && (
        <p className="dyn-note dyn-note--warn" role="status">
          {hint}
        </p>
      )}
      <footer className="dyn-side__foot">
        <span className="dyn-side__meta">
          {count} pending {count === 1 ? "change" : "changes"}
        </span>
        <span className="dyn-side__spacer" />
        <button
          type="button"
          className="q-button q-button--ghost"
          disabled={tab.applying}
          onClick={() => discardSelectedItemEdits(tab.id)}
        >
          Discard
        </button>
        <button
          type="button"
          className="q-button q-button--primary"
          disabled={tab.applying || tab.running}
          onClick={() => reviewSelectedItemEdits(tab.id)}
        >
          Apply
          <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.apply)}</kbd>
        </button>
      </footer>
    </>
  )
}

interface ItemDetailProps {
  tab: DynamoTab
  /** The selected item as loaded; its pending values are shown on top. */
  item: Item
  schema: KeySchema | null
  onEdit: () => void
  onClose: () => void
}

/**
 * The selected item as a tree (scalars edited in place) or as read-only JSON. Structural changes
 * go through Edit, which takes the item's pending changes along.
 */
export function ItemDetail({ tab, item, schema, onEdit, onClose }: ItemDetailProps) {
  const edit = itemEdit(tab.edits, item, schema)
  const shown = withPendingValues(item, edit)
  const conflicts = new Set(conflictingChanges(edit, item))
  const key = schema ? itemKey(item, schema) : null
  const view: DetailView = tab.panel.view
  const reviewing = tab.panel.reviewing && edit !== undefined
  const editable = key !== null && !tab.applying
  const count = Object.keys(shown).length

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return
    if (matchesShortcut(event, APP_SHORTCUTS.apply)) {
      // Here Mod+S reviews, then applies, this item's changes only; elsewhere it applies all.
      // An open tree field has already staged its value, or kept the event when it couldn't.
      event.preventDefault()
      event.stopPropagation()
      applyFromPanel(tab.id)
    } else if (reviewing && matchesShortcut(event, DYNAMO_SHORTCUTS.closeEditor)) {
      event.preventDefault()
      event.stopPropagation()
      cancelItemReview(tab.id)
    }
  }

  return (
    <aside className="dyn-side" aria-label="Item" onKeyDown={onKeyDown}>
      <header className="dyn-side__head">
        <span className="dyn-side__title">Item</span>
        <span className="dyn-side__meta">
          {count} {count === 1 ? "attribute" : "attributes"}
        </span>
        <span className="dyn-side__spacer" />
        <div className="dyn-compact">
          <SegmentedControl<DetailView>
            label="Item view"
            value={view}
            options={VIEW_OPTIONS}
            onChange={(next) => setDetailView(tab.id, next)}
          />
        </div>
        <button type="button" className="q-button q-button--ghost" onClick={onEdit}>
          <Pencil size={12} strokeWidth={2.2} />
          Edit
        </button>
        <button
          type="button"
          className="ui-icon-button"
          data-size="md"
          aria-label="Close item"
          onClick={onClose}
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </header>
      {reviewing ? (
        <Review tab={tab} edit={edit} conflicts={conflicts.size} />
      ) : (
        <>
          {view === "tree" ? (
            <ItemTree
              tabId={tab.id}
              itemId={key ? keyId(key) : ""}
              item={shown}
              schema={schema}
              edit={edit}
              conflicts={conflicts}
              expansion={tab.panel.tree}
              editable={editable}
            />
          ) : (
            <ItemJson tab={tab} item={shown} schema={schema} />
          )}
          {edit && <PendingFoot tab={tab} edit={edit} conflicts={conflicts.size} />}
        </>
      )}
    </aside>
  )
}
