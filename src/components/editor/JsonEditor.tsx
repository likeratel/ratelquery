import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { runPhysicalEditingShortcut } from "./physicalKeys"
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { searchKeymap } from "@codemirror/search"
import { EditorState } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import { useEffect, useRef } from "react"
import { tokenHighlightStyle, tokenTheme } from "./editorTheme"
import "./editor.css"

export interface JsonEditorProps {
  value: string
  onChange: (value: string) => void
  /** Runs in the keydown capture phase; return true to claim the event from CodeMirror. */
  onKeyDownCapture?: (event: KeyboardEvent) => boolean
  readOnly?: boolean
  autoFocus?: boolean
  ariaLabel?: string
}

/** Small CodeMirror editor for JSON text, with highlighting and folding. */
export function JsonEditor({
  value,
  onChange,
  onKeyDownCapture,
  readOnly = false,
  autoFocus = false,
  ariaLabel = "JSON",
}: JsonEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, onKeyDownCapture })

  useEffect(() => {
    latest.current = { onChange, onKeyDownCapture }
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          json(),
          syntaxHighlighting(tokenHighlightStyle),
          tokenTheme,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    if (autoFocus) view.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      // Keys that build an IME composition belong to the editor; repeats are left to the
      // shortcut handler, which claims them without running the action again.
      if (event.isComposing) return
      if (runPhysicalEditingShortcut(event, view)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (latest.current.onKeyDownCapture?.(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    host.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      host.removeEventListener("keydown", onKeyDown, { capture: true })
      view.destroy()
      viewRef.current = null
    }
    // One view per mount; value changes are synced below. Remount (key) to change readOnly.
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div className="sql-editor json-editor" ref={hostRef} />
}
