/**
 * `USE <database>` detection, so a script that switches databases moves the tab's Database
 * picker along with it. The next run sends the picked database explicitly; without that it
 * would run on whichever pooled connection comes back, which may not have seen the `USE`.
 */

import { tokenizeSql, type SqlToken } from "./sqlTokens"

/** The database `statement` selects when it is a `USE` statement, else null. */
export function useTarget(statement: string): string | null {
  const tokens = tokenizeSql(statement).filter((t) => t.kind !== "comment" && !isSemicolon(t))
  const [keyword, name, ...rest] = tokens
  if (keyword?.kind !== "word" || keyword.value.toLowerCase() !== "use") return null
  if (rest.length > 0 || !name) return null
  if (name.kind === "word") return name.value
  if (name.kind === "quoted" && name.closed && name.value !== "") return name.value
  return null
}

/**
 * The database each of `statements` ran in, run one after another from `initial`: a `USE`
 * changes it for the statements after it.
 */
export function databasesWhileRunning(
  statements: readonly string[],
  initial: string | null,
): (string | null)[] {
  let database = initial
  return statements.map((statement) => {
    const ran = database
    database = useTarget(statement) ?? database
    return ran
  })
}

/** The database selected by the last `USE` among `statements`, or null when none switches. */
export function lastUseTarget(statements: readonly string[]): string | null {
  for (let i = statements.length - 1; i >= 0; i -= 1) {
    const target = useTarget(statements[i] as string)
    if (target !== null) return target
  }
  return null
}

function isSemicolon(token: SqlToken): boolean {
  return token.kind === "punct" && token.value === ";"
}
