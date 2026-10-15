import { ipc, type AppError } from "./ipc"

/** What an `ssh_host_key` error says about the key the SSH server presented. */
export interface HostKeyDetails {
  /** Key algorithm, e.g. "ssh-ed25519". */
  keyType: string
  /** "SHA256:..." fingerprint of the presented key. */
  fingerprint: string
  /** The known_hosts line to append when the user trusts the key; null when none was given. */
  keyLine: string | null
  /**
   * The server presented a different (or revoked) key than the one on file. Never trusted from
   * the app.
   */
  changed: boolean
}

/** The message starts with the key type and its SHA256 fingerprint. */
const LEAD = /^\s*(\S+)\s+(SHA256:[A-Za-z0-9+/]+=*)/

/** Base64 key data of a known_hosts line. */
const KEY_DATA = "[A-Za-z0-9+/]{16,}={0,3}"

const CHANGED = /\b(changed|revoked)\b/i

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Reads the key type, fingerprint and known_hosts line out of an `ssh_host_key` message. The
 * backend starts the message with `<key type> SHA256:<fingerprint>`, says "changed" or
 * "revoked" for a key that must not be trusted, and ends it with the known_hosts line
 * (`<hosts> <key type> <base64>`) on its own line. Returns null when the message doesn't start
 * that way.
 */
export function parseHostKeyMessage(message: string): HostKeyDetails | null {
  const lead = LEAD.exec(message)
  if (!lead) return null
  const [, keyType, fingerprint] = lead
  const lines = message.trimEnd().split("\n")
  const last = lines.length > 1 ? lines[lines.length - 1].trim() : ""
  const linePattern = new RegExp(`^\\S+ ${escapeRegExp(keyType)} ${KEY_DATA}$`)
  return {
    keyType,
    fingerprint,
    keyLine: linePattern.test(last) ? last : null,
    changed: CHANGED.test(message),
  }
}

/** Start of the `ssh` error message when a key file is encrypted and no passphrase was given. */
export const PASSPHRASE_REQUIRED = "Key passphrase required"

/**
 * True when a connect failed only because the key file needs a passphrase. The backend
 * contract fixes this message prefix for exactly this case, so the prompt can be shown on it.
 */
export function isPassphraseRequired(error: AppError): boolean {
  return error.kind === "ssh" && error.message.startsWith(PASSPHRASE_REQUIRED)
}

/** True when the key can be trusted from the app: it is new (not changed) and has a line to save. */
export function canTrustHostKey(
  details: HostKeyDetails | null,
): details is HostKeyDetails & { keyLine: string } {
  return details !== null && !details.changed && details.keyLine !== null
}

export const sshApi = {
  /** Appends `keyLine` to the app's own known_hosts so the next connect accepts the key. */
  trustHost: (host: string, port: number, keyLine: string) =>
    ipc<void>("ssh_trust_host", { host, port, keyLine }),
}
