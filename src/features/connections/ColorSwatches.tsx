import { Check } from "lucide-react"
import { useId } from "react"
import { CONNECTION_COLORS } from "./colors"

interface ColorSwatchesProps {
  value: string
  onChange: (value: string) => void
}

export function ColorSwatches({ value, onChange }: ColorSwatchesProps) {
  const labelId = useId()
  return (
    <div className="ui-field">
      <span className="ui-field__label" id={labelId}>
        Color
        <span className="ui-field__optional">Optional</span>
      </span>
      <div className="conn-swatches" role="radiogroup" aria-labelledby={labelId}>
        <button
          type="button"
          role="radio"
          aria-checked={value === ""}
          aria-label="No color"
          className="conn-swatch conn-swatch--none"
          onClick={() => onChange("")}
        />
        {CONNECTION_COLORS.map((color) => {
          const checked = value.toLowerCase() === color.value
          return (
            <button
              key={color.value}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={color.label}
              title={color.label}
              className="conn-swatch"
              style={{ background: color.value }}
              onClick={() => onChange(color.value)}
            >
              {checked && <Check size={12} strokeWidth={3} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
