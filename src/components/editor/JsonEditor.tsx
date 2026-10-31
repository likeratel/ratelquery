import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { runPhysicalEditingShortcut } from "./physicalKeys"
import {
  bracketMatching,
  foldedRanges,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  unfoldEffect,
} from "@codemirror/language"
import {
  findNext,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search"
import { EditorState, type StateEffect } from "@codemirror/state"
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

/** Text to search for, and a counter that opens the search panel each time it changes. */
export interface JsonSearch {
  text: string
  caseSensitive: boolean
  request: number
}

/** A search match inside a folded region opens that region, so the match can be seen. */
const unfoldSearchMatch = EditorState.transactionExtender.of((tr) => {
  if (!tr.isUserEvent("select.search")) return null
  const effects: StateEffect<unknown>[] = []
  for (const range of tr.newSelection.ranges) {
    foldedRanges(tr.startState).between(range.from, range.to, (from, to) => {
      effects.push(unfoldEffect.of({ from, to }))
    })
  }
  return effects.length > 0 ? { effects } : null
})

/** Opens the search panel with `text` (when given) as its query. */
function showSearch(view: EditorView, text: string, caseSensitive: boolean, select: boolean) {
  if (text !== "") {
    const query = new SearchQuery({ search: text, caseSensitive, literal: true })
    view.dispatch({ effects: setSearchQuery.of(query) })
  }
  openSearchPanel(view)
  // The first match is selected, and so shown even inside a folded region.
  if (select && text !== "") findNext(view)
}

export interface JsonEditorProps {
  value: string
  onChange: (value: string) => void
  /** Runs in the keydown capture phase; return true to claim the event from CodeMirror. */
  onKeyDownCapture?: (event: KeyboardEvent) => boolean
  readOnly?: boolean
  autoFocus?: boolean
  ariaLabel?: string
  /** Prefills the search panel and opens it on mount (with text) or when `request` changes. */
  search?: JsonSearch
}

/** Small CodeMirror editor for JSON text, with highlighting and folding. */
export function JsonEditor({
  value,
  onChange,
  onKeyDownCapture,
  readOnly = false,
  autoFocus = false,
  ariaLabel = "JSON",
  search: searchRequest,
}: JsonEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, onKeyDownCapture, searchRequest })
  const seenRequest = useRef(searchRequest?.request)

  useEffect(() => {
    latest.current = { onChange, onKeyDownCapture, searchRequest }
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
          search(),
          highlightSelectionMatches(),
          unfoldSearchMatch,
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
    const initial = latest.current.searchRequest
    if (initial?.text) showSearch(view, initial.text, initial.caseSensitive, true)
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

  const request = searchRequest?.request
  useEffect(() => {
    const view = viewRef.current
    const current = latest.current.searchRequest
    if (!view || !current || request === seenRequest.current) return
    seenRequest.current = request
    view.focus()
    showSearch(view, current.text, current.caseSensitive, false)
  }, [request])

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
