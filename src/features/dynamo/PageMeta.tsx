import { formatElapsed } from "../../lib/cellFormat"
import type { Page } from "../../lib/dynamo"
import { useCountUp } from "../query/useCountUp"

/** Item count (counting up once per run), scanned count and elapsed time for a page. */
export function PageMeta({ page, runKey }: { page: Page; runKey: string }) {
  const shown = useCountUp(page.count, runKey)
  return (
    <div className="result-meta">
      <span className="result-meta__count">
        <span className="result-meta__number">{shown.toLocaleString()}</span>{" "}
        {page.count === 1 ? "item" : "items"}
      </span>
      {page.scannedCount !== page.count && (
        <span className="result-meta__muted" title="Items read before the filter was applied">
          {page.scannedCount.toLocaleString()} scanned
        </span>
      )}
      <span className="result-meta__muted">{formatElapsed(page.elapsedMs)}</span>
    </div>
  )
}
