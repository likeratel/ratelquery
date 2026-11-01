import { useEffect, useState, type KeyboardEvent } from "react"
import { TextField } from "../../components/ui"
import { numericCommit, parseNumericSetting, type NumericSetting } from "../../lib/settings"
import { isImeComposing } from "../../lib/shortcuts"

interface NumberSettingProps {
  field: NumericSetting
  label: string
  value: number
  hint?: string
  onCommit: (value: number) => void
}

/**
 * Numeric setting. Typing only changes the field; the value is saved on blur or Enter. Invalid
 * text stays in the field with an inline error and is never saved; a rolled-back save puts the
 * stored value back.
 */
export function NumberSetting({ field, label, value, hint, onCommit }: NumberSettingProps) {
  const [text, setText] = useState(String(value))
  const parsed = parseNumericSetting(field, text)

  useEffect(() => {
    setText((current) => {
      const shown = parseNumericSetting(field, current)
      return shown.ok && shown.value === value ? current : String(value)
    })
    // Only an outside change (load, commit, rollback) resyncs the text.
  }, [field, value])

  const commit = () => {
    const result = numericCommit(field, text, value)
    if (result.kind === "commit") onCommit(result.value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME composition must not commit.
    if (isImeComposing(event.nativeEvent)) return
    if (event.code === "Enter" || event.code === "NumpadEnter") commit()
  }

  return (
    <TextField
      label={label}
      value={text}
      onValueChange={setText}
      onBlur={commit}
      onKeyDown={onKeyDown}
      error={parsed.ok ? undefined : parsed.error}
      hint={hint}
      inputMode="numeric"
      className="settings-number"
    />
  )
}
