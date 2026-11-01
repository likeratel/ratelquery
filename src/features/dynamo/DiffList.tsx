import type { AttributeChange } from "../../lib/dynamoDiff"
import { attributeSummary } from "../../lib/dynamoView"

const SIGN: Record<AttributeChange["kind"], string> = { added: "+", changed: "~", removed: "−" }

/** Changes awaiting a save, as `name before → after` rows; used by every review before writing. */
export function DiffList({ changes }: { changes: readonly AttributeChange[] }) {
  return (
    <ul className="dyn-diff" aria-label="Changes">
      {changes.map((change) => (
        <li key={change.id ?? change.name} className="dyn-diff__row" data-kind={change.kind}>
          <span className="dyn-diff__sign" aria-label={change.kind}>
            {SIGN[change.kind]}
          </span>
          <span className="dyn-diff__name mono" title={change.name}>
            {change.name}
          </span>
          <span className="dyn-diff__values mono">
            {change.before && (
              <span className="dyn-diff__before">{attributeSummary(change.before)}</span>
            )}
            {change.before && change.after && <span className="dyn-diff__arrow">→</span>}
            {change.after && (
              <span className="dyn-diff__after">{attributeSummary(change.after)}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
