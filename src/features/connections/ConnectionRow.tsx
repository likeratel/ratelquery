import { Cloud, Database, Ellipsis, Pencil, Trash } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Button, Menu, showToast } from "../../components/ui"
import type { ConnectionConfig } from "../../lib/connections"
import { normalizeError } from "../../lib/ipc"
import { openQueryTabFor } from "../query"
import { useConnectionsStore } from "../../state/connectionsStore"
import { connectionSubtitle } from "./filter"

type RowMode = "idle" | "menu" | "confirm" | "deleting"

function openTab(config: ConnectionConfig): void {
  openQueryTabFor(config.id).catch((raw: unknown) => {
    showToast({
      tone: "error",
      message: `Could not open ${config.name}.`,
      detail: normalizeError(raw).message,
    })
  })
}

function DeleteConfirm({
  config,
  deleting,
  onCancel,
  onConfirm,
}: {
  config: ConnectionConfig
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.code === "Escape") {
      event.preventDefault()
      onCancel()
    }
  }
  return (
    <div className="conn-confirm" role="group" aria-label="Confirm delete" onKeyDown={onKeyDown}>
      <span className="conn-confirm__text">
        Delete <strong>{config.name}</strong>? The saved secret is removed too.
      </span>
      <div className="conn-confirm__actions">
        <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel} disabled={deleting}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" onClick={onConfirm} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </div>
  )
}

export function ConnectionRow({ config }: { config: ConnectionConfig }) {
  const [mode, setMode] = useState<RowMode>("idle")
  const closeMenu = useCallback(() => setMode((m) => (m === "menu" ? "idle" : m)), [])
  const Icon = config.kind === "mysql" ? Database : Cloud

  const onDelete = async () => {
    setMode("deleting")
    const result = await useConnectionsStore.getState().remove(config.id)
    if (!result.ok) {
      setMode("confirm")
      showToast({ tone: "error", message: result.error.summary, detail: result.error.detail })
    } else if (result.warning) {
      showToast({
        tone: "warning",
        message: `Removed ${config.name}, but its saved secret is still in the keychain.`,
        detail: result.warning.detail,
      })
    }
  }

  if (mode === "confirm" || mode === "deleting") {
    return (
      <li className="conn-row" data-mode="confirm">
        <DeleteConfirm
          config={config}
          deleting={mode === "deleting"}
          onCancel={() => setMode("idle")}
          onConfirm={onDelete}
        />
      </li>
    )
  }

  return (
    <li className="conn-row" data-mode={mode}>
      <button
        type="button"
        className="conn-row__main"
        onClick={() => openTab(config)}
        onContextMenu={(event) => {
          event.preventDefault()
          setMode("menu")
        }}
        title={`${config.name} · ${connectionSubtitle(config)}`}
      >
        <Icon
          size={14}
          strokeWidth={1.75}
          className="conn-row__icon"
          aria-label={config.kind === "mysql" ? "MySQL" : "DynamoDB"}
        />
        <span className="conn-row__text">
          <span className="conn-row__name">{config.name}</span>
          <span className="conn-row__sub mono">{connectionSubtitle(config)}</span>
        </span>
        {config.color && (
          <span className="conn-row__color" style={{ background: config.color }} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="ui-icon-button conn-row__more"
        aria-label={`Actions for ${config.name}`}
        aria-haspopup="menu"
        aria-expanded={mode === "menu"}
        onClick={() => setMode(mode === "menu" ? "idle" : "menu")}
      >
        <Ellipsis size={14} strokeWidth={2} />
      </button>
      {mode === "menu" && (
        <Menu
          label={`Actions for ${config.name}`}
          className="conn-row__menu"
          onClose={closeMenu}
          items={[
            {
              id: "edit",
              label: "Edit",
              icon: <Pencil size={13} aria-hidden />,
              onSelect: () => useConnectionsStore.getState().openDialog(config),
            },
            {
              id: "delete",
              label: "Delete",
              tone: "danger",
              icon: <Trash size={13} aria-hidden />,
              onSelect: () => setMode("confirm"),
            },
          ]}
        />
      )}
    </li>
  )
}
