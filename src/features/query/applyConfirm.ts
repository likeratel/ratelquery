import { create } from "zustand"
import { canConfirmApply, type ChangeCounts } from "../../lib/applyPlan"
import { normalizeError } from "../../lib/ipc"
import type { ChangePreview } from "../../lib/mysql"

/** The SQL preview shown in the apply dialog. */
export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; statements: readonly string[]; warning: string | null }
  | { status: "error"; message: string }

export interface ApplyRequest {
  /** `database.table` the changes go to. */
  table: string
  counts: ChangeCounts
  /** `query.trashRetentionDays` when the dialog opened. */
  retentionDays: number
}

export interface BackupFailedRequest {
  table: string
  /** The backend's reason. */
  message: string
  deletes: number
}

type Pending =
  | { kind: "apply"; id: number; request: ApplyRequest; preview: PreviewState }
  | { kind: "backup-failed"; id: number; request: BackupFailedRequest }

interface ApplyConfirmState {
  pending: Pending | null
}

export const useApplyConfirmStore = create<ApplyConfirmState>(() => ({ pending: null }))

let nextId = 1
/** Resolvers stay outside the store so its state is plain data. */
const resolvers = new Map<number, (confirmed: boolean) => void>()

/** Opens `pending`; a dialog already open is answered "no" first (one confirmation at a time). */
function open(pending: Pending): Promise<boolean> {
  const previous = useApplyConfirmStore.getState().pending
  if (previous) answerApplyConfirm(false)
  return new Promise((resolve) => {
    resolvers.set(pending.id, resolve)
    useApplyConfirmStore.setState({ pending })
  })
}

/**
 * Asks before applying grid changes that update or delete rows. `loadPreview` fills the SQL
 * list while the dialog is open; a failed preview is shown and the apply stays allowed, since
 * the backend checks everything again. Resolves true for Apply.
 */
export function confirmApply(
  request: ApplyRequest,
  loadPreview: () => Promise<ChangePreview>,
): Promise<boolean> {
  const id = nextId++
  const answer = open({ kind: "apply", id, request, preview: { status: "loading" } })
  const setPreview = (preview: PreviewState) => {
    const current = useApplyConfirmStore.getState().pending
    if (current?.kind === "apply" && current.id === id) {
      useApplyConfirmStore.setState({ pending: { ...current, preview } })
    }
  }
  loadPreview().then(
    (preview) =>
      setPreview({ status: "ready", statements: preview.statements, warning: preview.warning }),
    (raw: unknown) => setPreview({ status: "error", message: normalizeError(raw).message }),
  )
  return answer
}

/** Asks whether to delete without a backup after the trash refused it. True to go ahead. */
export function confirmApplyWithoutBackup(request: BackupFailedRequest): Promise<boolean> {
  return open({ kind: "backup-failed", id: nextId++, request })
}

/**
 * Answers the open dialog and closes it. A "yes" while the SQL preview is still loading is
 * ignored (the Apply button is disabled then).
 */
export function answerApplyConfirm(confirmed: boolean): void {
  const pending = useApplyConfirmStore.getState().pending
  if (!pending) return
  if (confirmed && pending.kind === "apply" && !canConfirmApply(pending.preview)) return
  useApplyConfirmStore.setState({ pending: null })
  const resolve = resolvers.get(pending.id)
  resolvers.delete(pending.id)
  resolve?.(confirmed)
}
