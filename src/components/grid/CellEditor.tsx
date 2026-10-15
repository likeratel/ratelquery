import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { NULL_INPUT } from "../../lib/cellEdit"
import { matchesShortcut, parseShortcut } from "../../lib/shortcuts"
import { commitOnce, type CommitGate } from "./commitGate"

/** Same physical key as the app's Apply shortcut. */
const APPLY_SHORTCUT = parseShortcut("Mod+S")

interface CellEditorProps {
  initial: string
  /** Returns an error message to keep editing, or null when the value was accepted. */
  onCommit: (text: string) => string | null
  onCancel: () => void
  /** Called after a successful commit made with Tab, to move right. */
  onTab?: (backwards: boolean) => void
}

export function CellEditor({ initial, onCommit, onCancel, onTab }: CellEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const gate = useRef<CommitGate>({ done: false })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): boolean => {
    const message = commitOnce(gate.current, text, initial, { onCommit, onCancel })
    setError(message)
    return message === null
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME composition (Korean, Japanese) must not commit the cell.
    if (event.nativeEvent.isComposing) return
    if (matchesShortcut(event, APPLY_SHORTCUT)) {
      // Record the typed value first, then let the event reach the app shortcut so Apply
      // includes it. An invalid value keeps the editor open and stops the apply.
      if (!commit()) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (event.code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      gate.current.done = true
      onCancel()
    } else if (event.code === "Enter" || event.code === "NumpadEnter") {
      if (event.metaKey || event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      commit()
    } else if (event.code === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      if (commit()) onTab?.(event.shiftKey)
    }
  }

  const onBlur = () => {
    if (gate.current.done) return
    // Leaving the cell keeps a valid value and drops an invalid one rather than trapping focus.
    if (!commit()) onCancel()
  }

  return (
    <div className="grid-editor">
      <input
        ref={inputRef}
        className="grid-editor__input"
        value={text}
        spellCheck={false}
        aria-invalid={error !== null}
        aria-label="Cell value"
        title={`Type ${NULL_INPUT} for SQL NULL`}
        onChange={(event) => {
          setText(event.target.value)
          setError(null)
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {error && (
        <div className="grid-editor__error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
