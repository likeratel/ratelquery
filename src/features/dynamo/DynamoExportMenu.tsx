import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { DynamoTab } from "../../lib/dynamoTabs"
import { DYNAMO_EXPORT_FORMATS, exportDynamo, type DynamoExportFormat } from "./exportDynamo"

/** Exports every item matching the request behind the current results. */
export function DynamoExportMenu({ tab }: { tab: DynamoTab }) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<DynamoExportFormat>("json")
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

  const { request, table } = tab
  const run = () => {
    setOpen(false)
    if (request && table) {
      void exportDynamo({ connectionId: tab.connectionId, table, request, format })
    }
  }

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className="q-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!request}
        title={request ? undefined : "Run a scan or query first"}
        onClick={() => setOpen((v) => !v)}
      >
        Export
        <ChevronDown size={12} strokeWidth={2} />
      </button>
      {open && (
        <div className="menu__popover" role="menu">
          <div className="menu__label">Format</div>
          <div className="segmented" role="radiogroup" aria-label="Export format">
            {DYNAMO_EXPORT_FORMATS.map((option) => (
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
          <div className="menu__label">Items</div>
          <button type="button" role="menuitem" className="menu__item" onClick={run}>
            All matching items
            <span className="menu__hint">
              {request && "scan" in request ? "Scans" : "Queries"} every page, not just this one
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
