import { create } from "zustand"
import { splitStatements } from "../../lib/sqlContext"
import { classifyDanger, withDefaultLimit } from "../../lib/sqlGuard"
import type { QuerySettings } from "../../lib/settings"

/** A statement that needs confirmation, with the reason shown in the dialog. */
export interface DangerousStatement {
  statement: string
  reason: string
}

/** A statement whose executed text got a LIMIT the editor doesn't show. */
export interface LimitedStatement {
  /** The executed text as the backend reports it in `RowsResult.statement`. */
  statement: string
  limit: number
}

export interface RunPlan {
  /** SQL to send: the original text when nothing changed. */
  sql: string
  changed: boolean
  limited: LimitedStatement[]
  dangers: DangerousStatement[]
}

/** The backend trims each statement and drops its terminating `;`. */
function executedForm(text: string): string {
  const trimmed = text.trim()
  return (trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed).trim()
}

/** Applies the query safety settings to `sql` without touching the editor text. */
export function planRun(sql: string, settings: QuerySettings): RunPlan {
  const statements = splitStatements(sql).map((s) => s.text)
  const dangers = settings.confirmDestructive
    ? statements.flatMap((statement) => {
        const reason = classifyDanger(statement)
        return reason ? [{ statement: executedForm(statement), reason }] : []
      })
    : []
  if (!settings.addLimitToSelect) return { sql, changed: false, limited: [], dangers }
  const rewritten = statements.map((statement) =>
    withDefaultLimit(statement, settings.defaultLimit),
  )
  const limited = rewritten.flatMap((text, i) =>
    text === statements[i] ? [] : [{ statement: executedForm(text), limit: settings.defaultLimit }],
  )
  if (limited.length === 0) return { sql, changed: false, limited, dangers }
  return { sql: rewritten.join("\n"), changed: true, limited, dangers }
}

interface PendingConfirm {
  dangers: readonly DangerousStatement[]
  resolve: (run: boolean) => void
}

interface RunGuardState {
  /** Statements whose LIMIT was added, per tab, for the last run. */
  limitedByTab: Readonly<Record<string, readonly LimitedStatement[]>>
  confirm: PendingConfirm | null
  setLimited: (tabId: string, limited: readonly LimitedStatement[]) => void
  forgetTab: (tabId: string) => void
}

export const useRunGuardStore = create<RunGuardState>((set) => ({
  limitedByTab: {},
  confirm: null,
  setLimited: (tabId, limited) =>
    set((state) => ({ limitedByTab: { ...state.limitedByTab, [tabId]: limited } })),
  forgetTab: (tabId) =>
    set((state) => {
      const { [tabId]: _dropped, ...rest } = state.limitedByTab
      return { limitedByTab: rest }
    }),
}))

/** Shows the destructive-statement dialog; resolves true for "Run anyway". */
export function confirmDangerousRun(dangers: readonly DangerousStatement[]): Promise<boolean> {
  const previous = useRunGuardStore.getState().confirm
  // Only one confirmation at a time; a second request cancels the first.
  previous?.resolve(false)
  return new Promise((resolve) => {
    useRunGuardStore.setState({ confirm: { dangers, resolve } })
  })
}

/** Answers the open confirmation and closes the dialog. */
export function answerDangerousRun(run: boolean): void {
  const pending = useRunGuardStore.getState().confirm
  if (!pending) return
  useRunGuardStore.setState({ confirm: null })
  pending.resolve(run)
}

/** The LIMIT added to `statement` in the tab's last run, if any. */
export function addedLimitFor(
  limited: readonly LimitedStatement[] | undefined,
  statement: string,
): number | null {
  return limited?.find((entry) => entry.statement === statement)?.limit ?? null
}
