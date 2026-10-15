import { describe, expect, it } from "vitest"
import {
  athenaErrorHint,
  AWS_CREDENTIAL_HINT,
  AWS_KEYS_CREDENTIAL_HINT,
  errorHint,
  errorLine,
} from "./errorHints"

describe("errorLine", () => {
  it("leads SSH errors with what failed and leaves others as the raw message", () => {
    expect(errorLine({ kind: "ssh", message: "auth rejected" })).toBe(
      "SSH connection failed: auth rejected",
    )
    expect(errorLine({ kind: "ssh_host_key", message: "unknown key" })).toBe(
      "SSH host key not trusted: unknown key",
    )
    expect(errorLine({ kind: "connection", message: "refused" })).toBe("refused")
  })
})

describe("errorHint", () => {
  it("has guidance for the SSH kinds", () => {
    expect(errorHint("ssh")).toContain("SSH tunnel")
    expect(errorHint("ssh_host_key")).toContain("host key")
  })
})

describe("athenaErrorHint", () => {
  it("gives the AWS credential hint, pointing key connections at the secret", () => {
    expect(athenaErrorHint("credential", "profile")).toBe(AWS_CREDENTIAL_HINT)
    expect(athenaErrorHint("credential")).toBe(AWS_CREDENTIAL_HINT)
    expect(athenaErrorHint("credential", "keys")).toBe(AWS_KEYS_CREDENTIAL_HINT)
  })

  it("names Athena instead of MySQL", () => {
    expect(athenaErrorHint("query")).toContain("Athena")
    expect(athenaErrorHint("query")).not.toContain("MySQL")
  })
})
