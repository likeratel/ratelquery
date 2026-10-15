import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { SegmentedControl } from "../../components/ui"
import type { KeySchema } from "../../lib/dynamo"
import { findLossyAttributes, formatItem } from "../../lib/dynamoJson"
import {
  canGoNext,
  canGoPrevious,
  pageNumber,
  selectedItem,
  type DynamoTab,
  type ItemView,
} from "../../lib/dynamoTabs"
import { deleteItem, openItemEditor, runDynamo, selectRow, setItemView } from "./actions"
import { DynamoExportMenu } from "./DynamoExportMenu"
import { DynamoErrorPanel } from "./errors"
import { ItemsGrid } from "./ItemsGrid"
import { JsonPreview } from "./JsonPreview"
import { PageMeta } from "./PageMeta"

const VIEW_OPTIONS = [
  { value: "table", label: "Table" },
  { value: "json", label: "JSON" },
] as const

function DeleteControl({ tab, onDone }: { tab: DynamoTab; onDone: () => void }) {
  const item = selectedItem(tab)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirming) {
    return (
      <button
        type="button"
        className="q-button q-button--ghost"
        disabled={!item || tab.running}
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={12} strokeWidth={2.2} />
        Delete item
      </button>
    )
  }
  return (
    <span className="dyn-confirm" role="group" aria-label="Confirm delete">
      <span className="dyn-confirm__text">Delete this item?</span>
      <button
        type="button"
        className="q-button q-button--ghost"
        disabled={busy}
        onClick={() => setConfirming(false)}
        onKeyDown={(event) => {
          if (event.code === "Escape") setConfirming(false)
        }}
        autoFocus
      >
        Cancel
      </button>
      <button
        type="button"
        className="q-button dyn-button--danger"
        disabled={busy || !item}
        onClick={async () => {
          if (!item) return
          setBusy(true)
          const deleted = await deleteItem(tab.id, item)
          setBusy(false)
          setConfirming(false)
          if (deleted) onDone()
        }}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </span>
  )
}

function JsonView({ tab }: { tab: DynamoTab }) {
  const item = selectedItem(tab)
  if (!item) return <div className="results__empty">Select an item to preview it as JSON.</div>
  const lossy = findLossyAttributes(item)
  return (
    <div className="dyn-json-view">
      {lossy.length > 0 && (
        <p className="dyn-note">
          Plain JSON shows sets as lists and binary as base64 text. Edit in wire mode to keep types.
        </p>
      )}
      <JsonPreview text={formatItem(item, "plain")} />
    </div>
  )
}

function Pager({ tab }: { tab: DynamoTab }) {
  const page = tab.page
  if (!page) return null
  return (
    <div className="dyn-pager">
      <span className="dyn-pager__page">Page {pageNumber(tab)}</span>
      {!page.lastKey && <span className="dyn-pager__end">End of results</span>}
      <span className="dyn-pager__spacer" />
      <button
        type="button"
        className="q-button q-button--ghost"
        disabled={!canGoPrevious(tab)}
        onClick={() => void runDynamo(tab.id, "previous")}
      >
        <ChevronLeft size={12} strokeWidth={2.2} />
        Previous
      </button>
      <button
        type="button"
        className="q-button"
        disabled={!canGoNext(tab)}
        onClick={() => void runDynamo(tab.id, "next")}
      >
        Next page
        <ChevronRight size={12} strokeWidth={2.2} />
      </button>
    </div>
  )
}

function Body({ tab, schema }: { tab: DynamoTab; schema: KeySchema | null }) {
  if (tab.error) return <DynamoErrorPanel error={tab.error} connectionId={tab.connectionId} />
  if (!tab.page) {
    return (
      <div className="results__empty">
        {tab.running ? "Running…" : "Run a scan or query to see items here."}
      </div>
    )
  }
  if (tab.page.items.length === 0) {
    return <div className="results__empty">No items on this page.</div>
  }
  if (tab.view === "json") return <JsonView tab={tab} />
  return (
    <ItemsGrid
      page={tab.page}
      schema={schema}
      selected={tab.selected}
      runKey={`${tab.id}:${tab.runId}`}
      onSelect={(index) => selectRow(tab.id, index)}
    />
  )
}

/** Toolbar, item grid or JSON view, and the pager for the current page. */
export function ItemsPanel({ tab, schema }: { tab: DynamoTab; schema: KeySchema | null }) {
  const item = selectedItem(tab)
  return (
    <section className="results dyn-results">
      <div className="result-toolbar">
        {tab.page && <PageMeta page={tab.page} runKey={`${tab.id}:${tab.runId}`} />}
        <span className="result-toolbar__spacer" />
        <div className="dyn-compact">
          <SegmentedControl<ItemView>
            label="Result view"
            value={tab.view}
            options={VIEW_OPTIONS}
            onChange={(view) => setItemView(tab.id, view)}
          />
        </div>
        <div className="result-toolbar__group" aria-label="Edit items">
          <button
            type="button"
            className="q-button q-button--ghost"
            disabled={!schema}
            onClick={() => openItemEditor(tab.id, null)}
          >
            <Plus size={12} strokeWidth={2.2} />
            New item
          </button>
          <DeleteControl
            key={tab.selected ?? -1}
            tab={tab}
            onDone={() => selectRow(tab.id, null)}
          />
          <button
            type="button"
            className="q-button q-button--ghost"
            disabled={!item || !schema}
            onClick={() => item && openItemEditor(tab.id, item)}
          >
            <Pencil size={12} strokeWidth={2.2} />
            Edit item
          </button>
        </div>
        <DynamoExportMenu tab={tab} />
      </div>
      <Body tab={tab} schema={schema} />
      <Pager tab={tab} />
    </section>
  )
}
