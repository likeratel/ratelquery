import { ChevronDown } from "lucide-react"
import { useCallback, useRef, useState } from "react"
import type { ExportScopeOption } from "../../lib/exportScopes"
import { Button } from "./Button"
import { Menu } from "./Menu"
import "./ui.css"

interface ExportMenuProps<F extends string, S extends string> {
  formats: readonly { format: F; label: string }[]
  defaultFormat: F
  /** Heading over the scopes, such as "Rows" or "Items". */
  scopesLabel: string
  scopes: readonly ExportScopeOption<S>[]
  onExport: (format: F, scope: S) => void
  disabled?: boolean
  /** Shown on the trigger while it is disabled. */
  disabledTitle?: string
}

/** "Export" button with a menu: format choice above the scopes to export. */
export function ExportMenu<F extends string, S extends string>({
  formats,
  defaultFormat,
  scopesLabel,
  scopes,
  onExport,
  disabled = false,
  disabledTitle,
}: ExportMenuProps<F, S>) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<F>(defaultFormat)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    // Esc, Tab or a choice leaves focus in the closing menu; hand it back to the button.
    if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
  }, [])

  return (
    <div className="ui-menu-anchor" ref={rootRef}>
      <Button
        ref={triggerRef}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Export
        <ChevronDown size={12} strokeWidth={2} />
      </Button>
      {open && (
        <Menu
          label="Export"
          className="ui-menu--dropdown"
          triggerRef={triggerRef}
          onClose={close}
          choice={{
            label: "Format",
            value: format,
            options: formats.map((f) => ({ value: f.format, label: f.label })),
            onChange: (value) => setFormat(value as F),
          }}
          itemsLabel={scopesLabel}
          items={scopes.map((scope) => ({
            id: scope.id,
            label: scope.label,
            hint: scope.hint,
            disabled: scope.disabled,
            title: scope.title,
            onSelect: () => onExport(format, scope.id),
          }))}
        />
      )}
    </div>
  )
}
