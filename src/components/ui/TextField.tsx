import { useId, type InputHTMLAttributes, type ReactNode } from "react"
import "./ui.css"

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  label: string
  value: string
  onValueChange: (value: string) => void
  hint?: ReactNode
  error?: string
  optional?: boolean
  mono?: boolean
}

export function TextField({
  label,
  value,
  onValueChange,
  hint,
  error,
  optional = false,
  mono = false,
  className,
  ...rest
}: TextFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ")
  return (
    <div className={["ui-field", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={id}>
        {label}
        {optional && <span className="ui-field__optional">Optional</span>}
      </label>
      <input
        id={id}
        className={mono ? "ui-input mono" : "ui-input"}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        {...rest}
      />
      {error && (
        <p id={errorId} className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="ui-field__hint">
          {hint}
        </p>
      )}
    </div>
  )
}
