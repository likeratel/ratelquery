import { useEffect, useRef, useState, type KeyboardEvent } from "react"

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
  const done = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): boolean => {
    if (text === initial) {
      done.current = true
      onCancel()
      return true
    }
    const message = onCommit(text)
    setError(message)
    if (message === null) done.current = true
    return message === null
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME composition (Korean, Japanese) must not commit the cell.
    if (event.nativeEvent.isComposing) return
    if (event.code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      done.current = true
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
    if (done.current) return
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
