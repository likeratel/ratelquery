import type { KeyboardEvent, ReactNode } from "react"
import "./ui.css"

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentOption<T>[]
  onChange: (value: T) => void
}

/** Radio-group style switcher. Arrow keys move between enabled options. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps<T>) {
  const enabled = options.filter((option) => !option.disabled)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.code]
    if (!step || enabled.length === 0) return
    event.preventDefault()
    const index = enabled.findIndex((option) => option.value === value)
    const next = enabled[(index + step + enabled.length) % enabled.length]
    onChange(next.value)
    const target = event.currentTarget.querySelector<HTMLButtonElement>(
      `[data-value="${CSS.escape(next.value)}"]`,
    )
    target?.focus()
  }

  return (
    <div className="ui-segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            className="ui-segmented__option"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
