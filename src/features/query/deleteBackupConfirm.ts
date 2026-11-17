import { create } from "zustand"
import type { BackupStoppedResult, DeletePlanEntry } from "../../lib/mysql"

type Pending =
  /** Before a run: these DELETE statements can't be backed up. */
  | { kind: "unsupported"; id: number; entries: readonly DeletePlanEntry[] }
  /** After a run stopped: this DELETE's backup failed at run time. */
  | { kind: "stopped"; id: number; stop: BackupStoppedResult }

interface DeleteBackupState {
  pending: Pending | null
}

export const useDeleteBackupStore = create<DeleteBackupState>(() => ({ pending: null }))

let nextId = 1
const resolvers = new Map<number, (confirmed: boolean) => void>()

function open(pending: Pending): Promise<boolean> {
  // One question at a time; a new one answers the open one with "no".
  if (useDeleteBackupStore.getState().pending) answerDeleteBackup(false)
  return new Promise((resolve) => {
    resolvers.set(pending.id, resolve)
    useDeleteBackupStore.setState({ pending })
  })
}

/** Asks before running DELETE statements that can't be backed up. True to run them anyway. */
export function confirmUnbackedDeletes(entries: readonly DeletePlanEntry[]): Promise<boolean> {
  return open({ kind: "unsupported", id: nextId++, entries })
}

/** Asks whether to go on without a backup after one failed at run time. */
export function confirmStoppedDelete(stop: BackupStoppedResult): Promise<boolean> {
  return open({ kind: "stopped", id: nextId++, stop })
}

/** Answers the open question and closes the dialog. */
export function answerDeleteBackup(confirmed: boolean): void {
  const pending = useDeleteBackupStore.getState().pending
  if (!pending) return
  useDeleteBackupStore.setState({ pending: null })
  const resolve = resolvers.get(pending.id)
  resolvers.delete(pending.id)
  resolve?.(confirmed)
}
