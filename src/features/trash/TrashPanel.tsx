import { X } from "lucide-react"
import { useEffect, useState } from "react"
import { Button, isModalOpen } from "../../components/ui"
import { isImeComposing } from "../../lib/shortcuts"
import { filterTrash, formatDeletedAt, statusNote, summaryLine } from "../../lib/trashView"
import { useSettingsStore } from "../../state/settingsStore"
import { useTrashStore } from "../../state/trashStore"
import { useUiStore } from "../../state/uiStore"
import { TrashDetail } from "./TrashDetail"
import { ConfirmEmptyDialog, RestoreConfirmDialog } from "./TrashDialogs"
import "./trash.css"

/** Closes the panel; the open entry closes with it. */
const close = () => {
  useUiStore.getState().closeTrash()
  void useTrashStore.getState().select(null)
}

/** What the trash holds and what it can't, shown above the list. */
function TrashIntro() {
  const days = useSettingsStore((s) => s.settings.query.trashRetentionDays)
  return (
    <div className="trash-intro">
      <p>
        Rows removed by grid deletes and by single-table <code>DELETE</code> statements are saved
        here before they are deleted, so you can restore them. Rows removed by{" "}
        <code>ON DELETE CASCADE</code>, triggers, stored procedures, <code>TRUNCATE</code> or{" "}
        <code>DROP</code> are not.
      </p>
      <p>
        The rows are stored unencrypted on this computer and removed after {days}{" "}
        {days === 1 ? "day" : "days"}.{" "}
        <button
          type="button"
          className="trash-link"
          onClick={() => useUiStore.getState().openSettings()}
        >
          Change in Settings
        </button>
      </p>
    </div>
  )
}

/** The Trash, shown in place of the workspace (not a tab). Close or Esc returns to the tabs. */
export function TrashPanel() {
  const summaries = useTrashStore((s) => s.summaries)
  const loadError = useTrashStore((s) => s.loadError)
  const selectedId = useTrashStore((s) => s.selectedId)
  const [query, setQuery] = useState("")
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const shown = filterTrash(summaries, query)

  useEffect(() => {
    void useTrashStore.getState().refresh()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Escape" || event.defaultPrevented || isModalOpen()) return
      // Esc that ends an IME composition (in the filter) belongs to the composition.
      if (isImeComposing(event)) return
      close()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <section className="trash" aria-label="Trash">
      <header className="trash__header">
        <h2 className="trash__title">Trash</h2>
        <span className="trash__spacer" />
        <Button
          variant="danger"
          size="sm"
          disabled={summaries.length === 0}
          onClick={() => setConfirmEmpty(true)}
        >
          Empty trash
        </Button>
        <button
          type="button"
          className="ui-icon-button"
          data-size="md"
          aria-label="Close Trash"
          title="Close (Esc)"
          onClick={close}
        >
          <X size={15} strokeWidth={2} />
        </button>
      </header>
      <TrashIntro />
      {loadError && (
        <p className="trash__error" role="alert">
          Couldn't read the trash: {loadError}
        </p>
      )}
      <div className="trash__body">
        <div className="trash__list-pane">
          <input
            className="ui-input trash__search"
            placeholder="Filter by connection, table or statement"
            aria-label="Filter the trash"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {shown.length === 0 ? (
            <p className="trash__empty">
              {summaries.length === 0 ? "The trash is empty." : "Nothing matches."}
            </p>
          ) : (
            <ul className="trash__list">
              {shown.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="trash-item"
                    aria-current={entry.id === selectedId}
                    onClick={() => void useTrashStore.getState().select(entry.id)}
                  >
                    <span className="trash-item__table">
                      {entry.database}.{entry.table}
                    </span>
                    <span className="trash-item__meta">
                      {formatDeletedAt(entry.deletedAt)} · {entry.connectionName}
                    </span>
                    <span className="trash-item__meta">
                      {summaryLine(entry)}
                      {entry.status !== "committed" && (
                        <span
                          className="badge badge--warn"
                          title={statusNote(entry.status) ?? undefined}
                        >
                          {entry.status}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="trash__detail-pane">
          {selectedId ? (
            <TrashDetail />
          ) : (
            <p className="trash__empty">Pick an entry to see its rows.</p>
          )}
        </div>
      </div>
      <RestoreConfirmDialog />
      {confirmEmpty && <ConfirmEmptyDialog onClose={() => setConfirmEmpty(false)} />}
    </section>
  )
}
