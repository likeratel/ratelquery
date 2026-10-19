import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { runPhysicalEditingShortcut } from "./physicalKeys"
import { MySQL, PostgreSQL, sql, type SQLDialect } from "@codemirror/lang-sql"
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  type ViewUpdate,
} from "@codemirror/view"
import { useEffect, useRef } from "react"
import type { EditorDialect } from "../../lib/sqlDialect"
import { cachedEditorState, cacheEditorState } from "./editorStateCache"
import { tokenHighlightStyle, tokenTheme } from "./editorTheme"
import "./editor.css"

export interface SqlEditorProps {
  /** Identity of the document; editor state (undo history, selection) is kept per key. */
  stateKey: string
  value: string
  onChange: (value: string) => void
  /**
   * Completion sources replacing the language's own (lang-sql keywords). Keep the array
   * identity stable; a new array reconfigures completion.
   */
  completionSources?: readonly CompletionSource[]
  /**
   * lang-sql dialect for highlighting and keyword completion. `postgresql` (used for Athena)
   * reads `"..."` as an identifier; `mysql` (the default) as a string.
   */
  dialect?: EditorDialect
  placeholderText?: string
  /**
   * Runs in the keydown capture phase, before CodeMirror's `key`-based keymap. Return true to
   * claim the event; it is then prevented and stopped so the editor never sees it.
   */
  onKeyDownCapture?: (event: KeyboardEvent, view: EditorView) => boolean
  /** Called when the selection changes (and once when the view mounts). */
  onSelectionChange?: (view: EditorView) => void
  onViewChange?: (view: EditorView | null) => void
  autoFocus?: boolean
}

export { forgetEditorState } from "./editorStateCache"

const DIALECTS: Record<EditorDialect, SQLDialect> = { mysql: MySQL, postgresql: PostgreSQL }

const languageSlot = new Compartment()
const completionSlot = new Compartment()
const changeHandlers = new Map<string, (update: ViewUpdate) => void>()

function completionFor(sources: readonly CompletionSource[] | undefined): Extension {
  return autocompletion({ icons: false, ...(sources ? { override: [...sources] } : {}) })
}

function languageFor(dialect: EditorDialect): Extension {
  return sql({ dialect: DIALECTS[dialect], upperCaseKeywords: true })
}

function baseExtensions(stateKey: string, placeholderText: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    // Completion must come before the default keymap so Enter accepts a suggestion
    // instead of inserting a newline while the list is open.
    keymap.of([
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    syntaxHighlighting(tokenHighlightStyle),
    tokenTheme,
    placeholder(placeholderText),
    EditorView.updateListener.of((update) => changeHandlers.get(stateKey)?.(update)),
  ]
}

export function SqlEditor({
  stateKey,
  value,
  onChange,
  completionSources,
  dialect = "mysql",
  placeholderText = "",
  onKeyDownCapture,
  onSelectionChange,
  onViewChange,
  autoFocus = false,
}: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, onKeyDownCapture, onSelectionChange, onViewChange })

  useEffect(() => {
    latest.current = { onChange, onKeyDownCapture, onSelectionChange, onViewChange }
  })

  useEffect(() => {
    changeHandlers.set(stateKey, (update) => {
      if (update.docChanged) latest.current.onChange(update.state.doc.toString())
      if (update.selectionSet || update.docChanged) {
        latest.current.onSelectionChange?.(update.view)
      }
    })
    return () => {
      changeHandlers.delete(stateKey)
    }
  }, [stateKey])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const cached = cachedEditorState(stateKey)
    const state =
      cached && cached.doc.toString() === value
        ? cached
        : EditorState.create({
            doc: value,
            extensions: [
              ...baseExtensions(stateKey, placeholderText),
              languageSlot.of(languageFor(dialect)),
              completionSlot.of(completionFor(completionSources)),
            ],
          })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    latest.current.onViewChange?.(view)
    latest.current.onSelectionChange?.(view)
    if (autoFocus) view.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      // Keys that build an IME composition (Korean, Japanese) belong to the editor. Key repeat
      // still reaches the handler so a held shortcut stays claimed; the app shortcut handler
      // ignores repeats instead of running the action again.
      if (event.isComposing) return
      if (runPhysicalEditingShortcut(event, view)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (latest.current.onKeyDownCapture?.(event, view)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    host.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      host.removeEventListener("keydown", onKeyDown, { capture: true })
      cacheEditorState(stateKey, view.state)
      latest.current.onViewChange?.(null)
      view.destroy()
      viewRef.current = null
    }
    // The view is created once per document; value and completion changes are synced below.
  }, [stateKey])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: completionSlot.reconfigure(completionFor(completionSources)),
    })
  }, [completionSources])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: languageSlot.reconfigure(languageFor(dialect)) })
  }, [dialect])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div className="sql-editor" ref={hostRef} />
}
