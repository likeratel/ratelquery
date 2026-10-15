import { useEffect, useState } from "react"
import { TextField } from "../../components/ui"
import { parseNumericSetting, type NumericSetting } from "../../lib/settings"

interface NumberSettingProps {
  field: NumericSetting
  label: string
  value: number
  hint?: string
  onCommit: (value: number) => void
}

/**
 * Numeric setting saved as soon as the text is valid. Invalid text stays in the field with an
 * inline error and is never saved; a rolled-back save puts the stored value back.
 */
export function NumberSetting({ field, label, value, hint, onCommit }: NumberSettingProps) {
  const [text, setText] = useState(String(value))
  const parsed = parseNumericSetting(field, text)

  useEffect(() => {
    setText((current) => {
      const shown = parseNumericSetting(field, current)
      return shown.ok && shown.value === value ? current : String(value)
    })
    // Only an outside change (load, rollback) resyncs the text.
  }, [field, value])

  const onValueChange = (next: string) => {
    setText(next)
    const result = parseNumericSetting(field, next)
    if (result.ok && result.value !== value) onCommit(result.value)
  }

  return (
    <TextField
      label={label}
      value={text}
      onValueChange={onValueChange}
      error={parsed.ok ? undefined : parsed.error}
      hint={hint}
      inputMode="numeric"
      className="settings-number"
    />
  )
}
