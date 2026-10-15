import { describe, expect, it } from "vitest"
import { canTrustHostKey, isPassphraseRequired, parseHostKeyMessage } from "./ssh"

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
const FINGERPRINT = "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s"

describe("parseHostKeyMessage", () => {
  it("reads the key type, fingerprint and the trailing known_hosts line of an unknown key", () => {
    const message = `ssh-ed25519 ${FINGERPRINT} is the host key of bastion:2222, which is not in known_hosts (a key of another type is on record). Trust it only if the fingerprint matches the server's.\n[bastion]:2222 ssh-ed25519 ${KEY}`
    expect(parseHostKeyMessage(message)).toEqual({
      keyType: "ssh-ed25519",
      fingerprint: FINGERPRINT,
      keyLine: `[bastion]:2222 ssh-ed25519 ${KEY}`,
      changed: false,
    })
  })

  it("flags a changed key", () => {
    const message = `ssh-rsa ${FINGERPRINT}: the host key of db:22 changed (/Users/me/.ssh/known_hosts line 4 has a different key). Someone may be intercepting the connection.\ndb ssh-rsa ${KEY}`
    expect(parseHostKeyMessage(message)).toEqual({
      keyType: "ssh-rsa",
      fingerprint: FINGERPRINT,
      keyLine: `db ssh-rsa ${KEY}`,
      changed: true,
    })
  })

  it("flags a revoked key", () => {
    const message = `ssh-ed25519 ${FINGERPRINT}: the host key of db:22 is revoked and must not be used.\ndb ssh-ed25519 ${KEY}`
    expect(parseHostKeyMessage(message)?.changed).toBe(true)
  })

  it("has no line when the last line isn't one for the same key type", () => {
    expect(
      parseHostKeyMessage(`ssh-ed25519 ${FINGERPRINT} unknown.\nh ssh-rsa ${KEY}`)?.keyLine,
    ).toBeNull()
    expect(
      parseHostKeyMessage(`ssh-ed25519 ${FINGERPRINT} h ssh-ed25519 ${KEY}`)?.keyLine,
    ).toBeNull()
  })

  it("returns null when the message doesn't start with a key type and fingerprint", () => {
    expect(parseHostKeyMessage("host key rejected")).toBeNull()
    expect(parseHostKeyMessage("ssh-ed25519 MD5:aa:bb")).toBeNull()
  })
})

describe("canTrustHostKey", () => {
  const unknown = parseHostKeyMessage(`ssh-ed25519 ${FINGERPRINT} new.\nh ssh-ed25519 ${KEY}`)

  it("allows only a new key that comes with a known_hosts line", () => {
    expect(canTrustHostKey(unknown)).toBe(true)
    expect(canTrustHostKey(unknown && { ...unknown, changed: true })).toBe(false)
    expect(canTrustHostKey(unknown && { ...unknown, keyLine: null })).toBe(false)
    expect(canTrustHostKey(null)).toBe(false)
  })
})

describe("isPassphraseRequired", () => {
  it("matches only the ssh error that starts with the passphrase marker", () => {
    expect(isPassphraseRequired({ kind: "ssh", message: "Key passphrase required for /k" })).toBe(
      true,
    )
    expect(isPassphraseRequired({ kind: "ssh", message: "SSH key authentication failed" })).toBe(
      false,
    )
    expect(isPassphraseRequired({ kind: "credential", message: "Key passphrase required" })).toBe(
      false,
    )
  })
})
