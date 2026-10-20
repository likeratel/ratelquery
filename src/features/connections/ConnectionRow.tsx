import { Ellipsis } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Button, showToast } from "../../components/ui"
import type { ConnectionConfig, ConnectionId } from "../../lib/connections"
import { normalizeError } from "../../lib/ipc"
import { openQueryTabFor } from "../query"
import {
  connectionKey,
  SchemaChildren,
  TreeChevron,
  TreeLevelOffset,
  useSchemaTree,
  useTreeTabIndex,
} from "../schema"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useSessionsStore } from "../../state/sessionsStore"
import { ConnectionMenu } from "./ConnectionMenu"
import { isPasswordCancelled } from "./connectSession"
import { errorDetail } from "./errors"
import { connectionSubtitle } from "./filter"
import { CONNECTION_KIND_ICON as KIND_ICON, CONNECTION_KIND_LABEL as KIND_LABEL } from "./kind"
import { dragAttributes, sameRef } from "./layoutTree"
import { hasNewRecovery, sessionStatus } from "./sessionStatus"
import { useDragState } from "./useLayoutDrag"

type RowMode = "idle" | "menu" | "move" | "confirm" | "deleting"

function openTab(config: ConnectionConfig): void {
  openQueryTabFor(config.id).catch((raw: unknown) => {
    // Closing the password prompt is the user's choice, not a failure.
    if (isPasswordCancelled(raw)) return
    showToast({
      tone: "error",
      message: `Couldn't open ${config.name}`,
      detail: errorDetail(normalizeError(raw)),
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

/** MySQL session state on the row icon; ripples once each time the session recovers. */
function SessionDot({ connectionId }: { connectionId: ConnectionId }) {
  const session = useSessionsStore((s) => s.sessions[connectionId])
  const [seenReconnects] = useState(() => session?.reconnects ?? 0)
  const status = sessionStatus(session)
  if (!status) return null
  return (
    <span
      className="dot conn-row__status"
      data-state={status.state}
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      {hasNewRecovery(session, seenReconnects) && (
        <span key={session?.reconnects} className="dot__ripple" aria-hidden />
      )}
    </span>
  )
}

interface ConnectionRowProps {
  config: ConnectionConfig
  /** Holds the tree's tab stop while no other node does. */
  tabStop?: boolean
  /** aria-level: 1 at the top of the list, 2 inside a folder. */
  level?: 1 | 2
}

export function ConnectionRow({ config, tabStop = false, level = 1 }: ConnectionRowProps) {
  const [mode, setMode] = useState<RowMode>("idle")
  const closeMenu = useCallback(
    () => setMode((m) => (m === "menu" || m === "move" ? "idle" : m)),
    [],
  )
  const moreRef = useRef<HTMLButtonElement>(null)
  const Icon = KIND_ICON[config.kind]
  const key = connectionKey(config.id)
  const ref = { type: "connection", id: config.id } as const
  const expanded = useSchemaTree((s) => Boolean(s.expanded[key]))
  const tabIndex = useTreeTabIndex(key, tabStop)
  const drop = useDragState((s) => (sameRef(s.over?.ref ?? null, ref) ? s.over?.position : null))
  const dragging = useDragState((s) => sameRef(s.dragging, ref))
  const treeItem = {
    role: "treeitem",
    "aria-level": level,
    "aria-label": config.name,
    "data-tree-key": key,
  } as const

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
      <li className="conn-row" data-mode="confirm" {...treeItem} tabIndex={-1}>
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
    <li
      className="conn-row"
      data-mode={mode}
      {...treeItem}
      aria-expanded={expanded}
      tabIndex={tabIndex}
      data-drop={drop ?? undefined}
      data-dragging={dragging || undefined}
    >
      <div className="conn-row__line" {...dragAttributes(ref)}>
        <TreeChevron
          expanded={expanded}
          label={config.name}
          onToggle={() => useSchemaTree.getState().toggle(key)}
        />
        <button
          type="button"
          className="conn-row__main"
          tabIndex={-1}
          data-tree-action=""
          onClick={() => openTab(config)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMode("menu")
          }}
          title={`${config.name} · ${connectionSubtitle(config)}`}
        >
          <span className="conn-row__icon-wrap">
            <Icon
              size={14}
              strokeWidth={1.75}
              className="conn-row__icon"
              aria-label={KIND_LABEL[config.kind]}
            />
            {config.kind === "mysql" && <SessionDot connectionId={config.id} />}
          </span>
          <span className="conn-row__text">
            <span className="conn-row__name">{config.name}</span>
            <span className="conn-row__sub mono">{connectionSubtitle(config)}</span>
          </span>
          {config.color && (
            <span className="conn-row__color" style={{ background: config.color }} aria-hidden />
          )}
        </button>
        <button
          ref={moreRef}
          type="button"
          className="ui-icon-button conn-row__more"
          tabIndex={-1}
          data-tree-menu=""
          aria-label={`Actions for ${config.name}`}
          aria-haspopup="menu"
          aria-expanded={mode === "menu" || mode === "move"}
          onClick={() => setMode(mode === "idle" ? "menu" : "idle")}
        >
          <Ellipsis size={14} strokeWidth={2} />
        </button>
        {(mode === "menu" || mode === "move") && (
          <ConnectionMenu
            config={config}
            kind={mode === "menu" ? "actions" : "move"}
            triggerRef={moreRef}
            onClose={closeMenu}
            onMove={() => setMode("move")}
            onDelete={() => setMode("confirm")}
          />
        )}
      </div>
      {expanded && (
        <ul role="group" className="tree-group">
          <TreeLevelOffset value={level - 1}>
            <SchemaChildren config={config} />
          </TreeLevelOffset>
        </ul>
      )}
    </li>
  )
}
