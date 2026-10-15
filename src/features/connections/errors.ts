import type { AppError, AppErrorKind } from "../../lib/ipc"

export type ConnectionAction = "load" | "save" | "delete" | "test"

export interface FriendlyError {
  /** Short sentence safe to show in the UI. */
  summary: string
  /** Raw backend message, shown as secondary text. Never used for branching. */
  detail: string
}

const SUMMARY_BY_KIND: Record<AppErrorKind, string> = {
  invalid_input: "Some fields are not valid.",
  not_found: "This connection no longer exists.",
  connection: "Could not reach the server. Check the host, port and network.",
  query: "The server rejected the request.",
  credential: "Credentials were rejected or could not be read from the keychain.",
  io: "Could not read or write the connection settings file.",
  unknown: "Something went wrong.",
}

const ACTION_PREFIX: Record<ConnectionAction, string> = {
  load: "Could not load connections.",
  save: "Could not save the connection.",
  delete: "Could not delete the connection.",
  test: "Connection test failed.",
}

/** Appended to the detail when the user denied the keychain prompt. */
export const KEYCHAIN_DENIED_TIP = "Tip: switch Password storage to App file in Settings (⌘,)"

/** Phrases the OS keychain uses when the user denies access. */
const KEYCHAIN_DENIED = /user (canceled|cancelled)|user interaction is not allowed/i

/**
 * Secondary text for an error: the raw message, plus a tip when the keychain refused access.
 * Only the detail looks at the text; summaries and behavior still branch on `kind` alone.
 */
export function errorDetail(error: AppError): string {
  if (error.kind === "credential" && KEYCHAIN_DENIED.test(error.message)) {
    return `${error.message} ${KEYCHAIN_DENIED_TIP}`
  }
  return error.message
}

/** Maps an AppError to user-facing copy, branching only on `kind`. */
export function describeError(error: AppError, action: ConnectionAction): FriendlyError {
  if (action === "test" && error.kind === "connection") {
    return { summary: SUMMARY_BY_KIND.connection, detail: error.message }
  }
  return {
    summary: `${ACTION_PREFIX[action]} ${SUMMARY_BY_KIND[error.kind]}`,
    detail: errorDetail(error),
  }
}
