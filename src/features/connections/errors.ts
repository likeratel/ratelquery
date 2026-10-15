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

/** Maps an AppError to user-facing copy, branching only on `kind`. */
export function describeError(error: AppError, action: ConnectionAction): FriendlyError {
  if (action === "test" && error.kind === "connection") {
    return { summary: SUMMARY_BY_KIND.connection, detail: error.message }
  }
  return {
    summary: `${ACTION_PREFIX[action]} ${SUMMARY_BY_KIND[error.kind]}`,
    detail: error.message,
  }
}
