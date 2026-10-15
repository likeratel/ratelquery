import { Fragment } from "react"
import { formatShortcut, parseShortcut } from "../../lib/shortcuts"

const HINTS = [
  { keys: "Mod+N", label: "New connection" },
  { keys: "Mod+T", label: "New tab" },
  { keys: "Mod+Enter", label: "Run query" },
  { keys: "Mod+B", label: "Toggle sidebar" },
]

export function EmptyWorkspace() {
  return (
    <section className="empty">
      <div className="empty__card">
        <h1 className="empty__title">Open a MySQL or DynamoDB connection to begin</h1>
        <p className="empty__lede">
          Shortcuts work on the physical key, so they keep working while a Korean or Japanese input
          source is active.
        </p>
        <dl className="empty__shortcuts">
          {HINTS.map((hint) => (
            <Fragment key={hint.keys}>
              <dt>
                <kbd className="kbd">{formatShortcut(parseShortcut(hint.keys))}</kbd>
              </dt>
              <dd>{hint.label}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </section>
  )
}
