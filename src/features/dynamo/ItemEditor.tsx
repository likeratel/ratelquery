import { X } from "lucide-react"
import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { isFromEditorPanel } from "../../components/editor/editorPanel"
import { JsonEditor } from "../../components/editor/lazyEditors"
import { SegmentedControl } from "../../components/ui"
import type { KeySchema } from "../../lib/dynamo"
import { diffItems, keyChanged, putExpectation, type AttributeChange } from "../../lib/dynamoDiff"
import { findLossyAttributes, parseItem, type JsonMode } from "../../lib/dynamoJson"
import type { DiscardIntent, DynamoTab, ItemEditorState } from "../../lib/dynamoTabs"
import { attributeSummary } from "../../lib/dynamoView"
import { formatShortcut, matchesShortcut } from "../../lib/shortcuts"
import { APP_SHORTCUTS, handleAppShortcut } from "../query/appShortcuts"
import {
  backToEdit,
  closeItemEditor,
  confirmSave,
  discardEditorChanges,
  escapeEditor,
  keepEditing,
  reviewEdit,
  setEditorText,
  switchEditorMode,
} from "./actions"
import { DYNAMO_SHORTCUTS } from "./shortcuts"

const SIGN: Record<AttributeChange["kind"], string> = { added: "+", changed: "~", removed: "−" }

function DiffList({ changes }: { changes: readonly AttributeChange[] }) {
  return (
    <ul className="dyn-diff" aria-label="Changes">
      {changes.map((change) => (
        <li key={change.name} className="dyn-diff__row" data-kind={change.kind}>
          <span className="dyn-diff__sign" aria-label={change.kind}>
            {SIGN[change.kind]}
          </span>
          <span className="dyn-diff__name mono">{change.name}</span>
          <span className="dyn-diff__values mono">
            {change.before && (
              <span className="dyn-diff__before">{attributeSummary(change.before)}</span>
            )}
            {change.before && change.after && <span className="dyn-diff__arrow">→</span>}
            {change.after && (
              <span className="dyn-diff__after">{attributeSummary(change.after)}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

interface ConfirmationProps {
  tabId: string
  editor: ItemEditorState
  schema: KeySchema
}

function Confirmation({ tabId, editor, schema }: ConfirmationProps) {
  const pending = editor.pending
  const saveRef = useRef<HTMLButtonElement>(null)
  useEffect(() => saveRef.current?.focus(), [])
  if (!pending) return null
  const changes = diffItems(editor.original, pending)
  const expect = putExpectation(editor.original, pending, schema)
  const noun = changes.length === 1 ? "change" : "changes"
  return (
    <div className="dyn-editor__review">
      <p className="dyn-editor__summary">
        {changes.length} {noun} ·{" "}
        {expect === "exists"
          ? "saves only if the item still exists"
          : "creates the item only if no item has this key"}
      </p>
      <DiffList changes={changes} />
      <footer className="dyn-side__foot">
        <button
          type="button"
          className="q-button q-button--ghost"
          disabled={editor.saving}
          onClick={() => backToEdit(tabId)}
        >
          Back
        </button>
        <span className="dyn-side__spacer" />
        <button
          ref={saveRef}
          type="button"
          className="q-button q-button--primary"
          disabled={editor.saving}
          onClick={() => void confirmSave(tabId)}
        >
          {editor.saving ? "Saving…" : expect === "exists" ? "Save item" : "Create item"}
        </button>
      </footer>
    </div>
  )
}

/** Why the editor would close, added to the "Discard changes?" prompt. */
function discardDetail(intent: DiscardIntent): string {
  switch (intent.kind) {
    case "close":
      return ""
    case "table":
      return ` Switching to ${intent.table} closes the editor.`
    case "open":
      return intent.item
        ? " Editing another item closes this one."
        : " Starting a new item closes this one."
  }
}

/** Inline "Discard changes?" prompt shown before unsaved text would be thrown away. */
function DiscardPrompt({ tabId, intent }: { tabId: string; intent: DiscardIntent }) {
  const keepRef = useRef<HTMLButtonElement>(null)
  useEffect(() => keepRef.current?.focus(), [])
  return (
    <div className="dyn-note dyn-note--warn dyn-discard" role="alert">
      <span className="dyn-discard__text">Discard changes?{discardDetail(intent)}</span>
      <button
        ref={keepRef}
        type="button"
        className="q-button q-button--ghost"
        onClick={() => keepEditing(tabId)}
      >
        Keep editing
      </button>
      <button
        type="button"
        className="q-button q-button--primary"
        onClick={() => void discardEditorChanges(tabId)}
      >
        Discard
      </button>
    </div>
  )
}

interface ItemEditorProps {
  tab: DynamoTab
  editor: ItemEditorState
  schema: KeySchema | null
}

/** Plain or wire JSON editor for one item, with a diff confirmation before writing. */
export function ItemEditor({ tab, editor, schema }: ItemEditorProps) {
  const parsed = useMemo(() => parseItem(editor.text, editor.mode), [editor.text, editor.mode])
  const lossy = useMemo(() => {
    const item = parsed.ok ? parsed.value : editor.original
    return item ? findLossyAttributes(item) : []
  }, [parsed, editor.original])
  const candidate = editor.stage === "confirm" ? editor.pending : parsed.ok ? parsed.value : null
  const keyMoved = Boolean(
    editor.original && candidate && schema && keyChanged(editor.original, candidate, schema),
  )
  const error = editor.error ?? (parsed.ok ? null : parsed.error)

  const onShortcut = (event: KeyboardEvent): boolean => {
    if (matchesShortcut(event, DYNAMO_SHORTCUTS.closeEditor)) {
      // Esc in the search panel closes the panel, not the editor.
      if (isFromEditorPanel(event.target)) return false
      escapeEditor(tab.id)
      return true
    }
    return handleAppShortcut(event)
  }

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // CodeMirror marks keys it handled (such as Esc closing its search panel) as default-prevented.
    if (event.defaultPrevented || isFromEditorPanel(event.target)) return
    if (matchesShortcut(event, DYNAMO_SHORTCUTS.closeEditor)) {
      event.preventDefault()
      event.stopPropagation()
      escapeEditor(tab.id)
    }
  }

  const plainReason = lossy.length > 0 ? `${lossy[0].path}: ${lossy[0].reason}` : null
  const modeOptions = [
    {
      value: "plain" as JsonMode,
      label: "Plain",
      disabled: plainReason !== null && editor.mode !== "plain",
    },
    { value: "wire" as JsonMode, label: "Wire" },
  ]

  return (
    <aside className="dyn-side dyn-editor" aria-label="Item editor" onKeyDown={onPanelKeyDown}>
      <header className="dyn-side__head">
        <span className="dyn-side__title">{editor.original ? "Edit item" : "New item"}</span>
        <span className="dyn-side__spacer" />
        <div className="dyn-compact" title={plainReason ?? undefined}>
          <SegmentedControl<JsonMode>
            label="JSON format"
            value={editor.mode}
            options={modeOptions}
            onChange={(mode) => switchEditorMode(tab.id, mode)}
          />
        </div>
        <button
          type="button"
          className="ui-icon-button"
          data-size="md"
          aria-label="Close editor"
          title={`Close (${formatShortcut(DYNAMO_SHORTCUTS.closeEditor)})`}
          disabled={editor.saving}
          onClick={() => closeItemEditor(tab.id)}
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </header>
      {plainReason && editor.mode === "wire" && (
        <p className="dyn-note">
          Plain mode is off: {plainReason}
          {lossy.length > 1 ? ` (and ${lossy.length - 1} more)` : ""}.
        </p>
      )}
      {editor.discard && <DiscardPrompt tabId={tab.id} intent={editor.discard} />}
      {keyMoved && (
        <p className="dyn-note dyn-note--warn">
          The key changed, so this saves as a new item. The original item stays.
        </p>
      )}
      {editor.stage === "edit" || !schema ? (
        <>
          <div className="dyn-editor__code">
            <JsonEditor
              value={editor.text}
              onChange={(text) => setEditorText(tab.id, text)}
              onKeyDownCapture={onShortcut}
              ariaLabel="Item JSON"
              autoFocus
            />
          </div>
          {error && (
            <p className="dyn-editor__error" role="alert">
              {error}
            </p>
          )}
          <footer className="dyn-side__foot">
            <button
              type="button"
              className="q-button q-button--ghost"
              onClick={() => closeItemEditor(tab.id)}
            >
              Cancel
            </button>
            <span className="dyn-side__spacer" />
            <button
              type="button"
              className="q-button q-button--primary"
              disabled={!parsed.ok}
              onClick={() => reviewEdit(tab.id)}
            >
              Review changes
              <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.apply)}</kbd>
            </button>
          </footer>
        </>
      ) : (
        <>
          {editor.error && (
            <p className="dyn-editor__error" role="alert">
              {editor.error}
            </p>
          )}
          <Confirmation tabId={tab.id} editor={editor} schema={schema} />
        </>
      )}
    </aside>
  )
}
