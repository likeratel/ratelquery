import { describe, expect, it } from "vitest"
import { errorHint, errorLine } from "./errorHints"

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
