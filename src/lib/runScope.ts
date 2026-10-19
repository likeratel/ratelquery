import { statementAtCursor, type SqlSyntax } from "./sqlContext"

/** What a run shortcut executes: the statement under the cursor, or the editor selection. */
export type RunScope = "statement" | "selection"

export interface RunScopeInput {
  /** Whole editor text. */
  sql: string
  /** Cursor offset; the end of the text when unknown. */
  cursor?: number
  /** Selected editor text, if any. */
  selectedText?: string
}

export interface RunScopeText {
  /** Text to run; null means the whole editor. */
  sql: string | null
}

/**
 * Text a run shortcut executes. `statement` is the statement at the cursor (null when there is
 * none). `selection` is the selected text, or the whole editor when nothing is selected, so
 * Mod+Shift+Enter still runs everything in a tab without a selection.
 */
export function runScopeText(
  scope: RunScope,
  input: RunScopeInput,
  syntax: SqlSyntax,
): RunScopeText | null {
  if (scope === "selection") {
    const selected = input.selectedText ?? ""
    return { sql: selected.trim() === "" ? null : selected }
  }
  const cursor = input.cursor ?? input.sql.length
  const statement = statementAtCursor(input.sql, cursor, syntax)
  return statement ? { sql: statement.text } : null
}
