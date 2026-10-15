import { create } from "zustand"
import { splitStatements, type StatementRange } from "../../lib/sqlContext"
import { classifyDanger, withDefaultLimit } from "../../lib/sqlGuard"
import type { QuerySettings } from "../../lib/settings"

/** A statement that needs confirmation, with the reason shown in the dialog. */
export interface DangerousStatement {
  statement: string
  reason: string
}

/** A statement whose executed text got a LIMIT the editor doesn't show. */
export interface LimitedStatement {
  /**
   * Position of the statement in the run. The backend returns one result per statement in
   * order, so this is also the index of its result.
   */
  index: number
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

/**
 * Applies the query safety settings to `sql` without touching the editor text. A LIMIT is
 * spliced into each statement's own range, so everything between statements (comments,
 * blank lines) reaches the backend as written.
 */
export function planRun(sql: string, settings: QuerySettings): RunPlan {
  const statements = splitStatements(sql)
  const dangers = settings.confirmDestructive
    ? statements.flatMap(({ text }) => {
        const reason = classifyDanger(text)
        return reason ? [{ statement: executedForm(text), reason }] : []
      })
    : []
  if (!settings.addLimitToSelect) return { sql, changed: false, limited: [], dangers }
  const rewritten = statements.map(({ text }) => withDefaultLimit(text, settings.defaultLimit))
  const limited = rewritten.flatMap((text, index) =>
    text === statements[index]?.text ? [] : [{ index, limit: settings.defaultLimit }],
  )
  if (limited.length === 0) return { sql, changed: false, limited, dangers }
  return { sql: spliceStatements(sql, statements, rewritten), changed: true, limited, dangers }
}

/** `sql` with each statement range replaced by its rewritten text. */
function spliceStatements(
  sql: string,
  statements: readonly StatementRange[],
  rewritten: readonly string[],
): string {
  const { out, cursor } = statements.reduce(
    (acc, range, i) => ({
      out: acc.out + sql.slice(acc.cursor, range.from) + (rewritten[i] ?? range.text),
      cursor: range.to,
    }),
    { out: "", cursor: 0 },
  )
  return out + sql.slice(cursor)
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

/** The LIMIT added to the statement behind result `index` in the tab's last run, if any. */
export function addedLimitFor(
  limited: readonly LimitedStatement[] | undefined,
  index: number,
): number | null {
  return limited?.find((entry) => entry.index === index)?.limit ?? null
}
