import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { ExportFormat, RowsResult } from "../../lib/mysql"
import { EXPORT_FORMATS, exportResult, type ExportScope } from "./exportResult"

interface ExportMenuProps {
  connectionId: string
  result: RowsResult
  /** Full export re-runs the statement, so it is only offered for single-statement runs. */
  allowFull: boolean
  database: string | null
}

export function ExportMenu({ connectionId, result, allowFull, database }: ExportMenuProps) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<ExportFormat>("csv")
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const run = (scope: ExportScope) => {
    setOpen(false)
    void exportResult({ connectionId, result, format, scope, database })
  }

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className="q-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Export
        <ChevronDown size={12} strokeWidth={2} />
      </button>
      {open && (
        <div className="menu__popover" role="menu">
          <div className="menu__label">Format</div>
          <div className="segmented" role="radiogroup" aria-label="Export format">
            {EXPORT_FORMATS.map((option) => (
              <button
                key={option.format}
                type="button"
                role="radio"
                aria-checked={format === option.format}
                className="segmented__item"
                onClick={() => setFormat(option.format)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="menu__label">Rows</div>
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => run("visible")}
          >
            Visible rows
            <span className="menu__hint">{result.rowCount.toLocaleString()} loaded</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            disabled={!allowFull}
            title={allowFull ? undefined : "Run a single statement to export its full result"}
            onClick={() => run("full")}
          >
            Full result
            <span className="menu__hint">
              {allowFull ? "Re-runs without the row limit" : "Single statement only"}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
