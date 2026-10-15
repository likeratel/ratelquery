import type { AppErrorKind } from "./ipc"

const HINTS: Record<AppErrorKind, string> = {
  query: "MySQL rejected the statement. Statements before it in the script already ran.",
  connection:
    "The connection dropped and one automatic retry failed. Check that the server is reachable, then run again.",
  credential: "The stored credentials were rejected. Edit the connection to update the password.",
  invalid_input: "The request was rejected before reaching MySQL.",
  not_found: "The connection or object no longer exists.",
  io: "A local file or system operation failed.",
  unknown: "Something unexpected happened.",
}

/** Short guidance shown under the raw error message, chosen by `kind` only. */
export function errorHint(kind: AppErrorKind): string {
  return HINTS[kind]
}
