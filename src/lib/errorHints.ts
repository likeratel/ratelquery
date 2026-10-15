import type { AppError, AppErrorKind } from "./ipc"

const HINTS: Record<AppErrorKind, string> = {
  query: "MySQL rejected the statement. Statements before it in the script already ran.",
  connection:
    "The connection dropped and one automatic retry failed. Check that the server is reachable, then run again.",
  credential: "The stored credentials were rejected. Edit the connection to update the password.",
  invalid_input: "The request was rejected before reaching MySQL.",
  not_found: "The connection or object no longer exists.",
  io: "A local file or system operation failed.",
  ssh: "The SSH tunnel failed. Check the SSH host, user and key or password, then run again.",
  ssh_host_key:
    "The SSH server's host key isn't trusted. Open the connection again to review its fingerprint.",
  unknown: "Something unexpected happened.",
}

/** Short guidance shown under the raw error message, chosen by `kind` only. */
export function errorHint(kind: AppErrorKind): string {
  return HINTS[kind]
}

/** What failed, for kinds whose raw message doesn't say it went through SSH. */
const LEADS: Partial<Record<AppErrorKind, string>> = {
  ssh: "SSH connection failed",
  ssh_host_key: "SSH host key not trusted",
}

/**
 * One-line error text for compact places (tree rows, tab banners): the raw message, led by
 * what failed for SSH errors. Chosen by `kind` only.
 */
export function errorLine(error: AppError): string {
  const lead = LEADS[error.kind]
  return lead ? `${lead}: ${error.message}` : error.message
}
