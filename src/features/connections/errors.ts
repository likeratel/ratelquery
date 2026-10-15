import type { AppError, AppErrorKind } from "../../lib/ipc"

export type ConnectionAction = "load" | "save" | "delete" | "test" | "create-bucket"

export interface FriendlyError {
  /** Short sentence safe to show in the UI. */
  summary: string
  /** Raw backend message, shown as secondary text. Never used for branching. */
  detail: string
}

const SUMMARY_BY_KIND: Record<AppErrorKind, string> = {
  invalid_input: "Some fields are not valid.",
  not_found: "This connection no longer exists.",
  connection: "Couldn't reach the server. Check the host, port and network.",
  query: "The server rejected the request.",
  credential: "Credentials were rejected or couldn't be read from the keychain.",
  io: "Couldn't read or write the connection settings file.",
  ssh: "SSH connection failed.",
  ssh_host_key: "The SSH server's host key isn't trusted.",
  unknown: "Something went wrong.",
}

const ACTION_PREFIX: Record<ConnectionAction, string> = {
  load: "Couldn't load connections.",
  save: "Couldn't save the connection.",
  delete: "Couldn't delete the connection.",
  test: "Connection test failed.",
  "create-bucket": "Couldn't create the bucket.",
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

/** Kinds a failed connection test states directly, without the "test failed" prefix. */
const DIRECT_TEST_KINDS: ReadonlySet<AppErrorKind> = new Set(["connection", "ssh", "ssh_host_key"])

/** Maps an AppError to user-facing copy, branching only on `kind`. */
export function describeError(error: AppError, action: ConnectionAction): FriendlyError {
  if (action === "test" && DIRECT_TEST_KINDS.has(error.kind)) {
    return { summary: SUMMARY_BY_KIND[error.kind], detail: error.message }
  }
  return {
    summary: `${ACTION_PREFIX[action]} ${SUMMARY_BY_KIND[error.kind]}`,
    detail: errorDetail(error),
  }
}
