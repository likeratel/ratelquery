import { useId } from "react"

interface ToggleSettingProps {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}

/** Checkbox setting with a one-line explanation under the label. */
export function ToggleSetting({ label, hint, checked, onChange }: ToggleSettingProps) {
  const hintId = useId()
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hint ? hintId : undefined}
      />
      <span className="settings-toggle__text">
        <span>{label}</span>
        {hint && (
          <span id={hintId} className="settings-toggle__hint">
            {hint}
          </span>
        )}
      </span>
    </label>
  )
}
