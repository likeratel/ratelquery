import { describe, expect, it } from "vitest"
import type { AppErrorKind } from "../../lib/ipc"
import { describeError, errorDetail, KEYCHAIN_DENIED_TIP } from "./errors"

const KINDS: AppErrorKind[] = [
  "invalid_input",
  "not_found",
  "connection",
  "query",
  "credential",
  "io",
  "unknown",
]

describe("describeError", () => {
  it("gives every kind a distinct sentence and keeps the raw message as detail", () => {
    const summaries = KINDS.map((kind) => describeError({ kind, message: "raw" }, "save"))
    expect(new Set(summaries.map((s) => s.summary)).size).toBe(KINDS.length)
    summaries.forEach((s) => {
      expect(s.summary.startsWith("Couldn't save the connection.")).toBe(true)
      expect(s.detail).toBe("raw")
    })
  })

  it("branches on kind, not message text", () => {
    const a = describeError({ kind: "credential", message: "connection refused" }, "load")
    expect(a.summary).toContain("Credentials were rejected")
  })

  it("uses a direct sentence for failed connection tests", () => {
    expect(describeError({ kind: "connection", message: "timeout" }, "test")).toEqual({
      summary: "Couldn't reach the server. Check the host, port and network.",
      detail: "timeout",
    })
    expect(describeError({ kind: "credential", message: "denied" }, "test").summary).toBe(
      "Connection test failed. Credentials were rejected or couldn't be read from the keychain.",
    )
  })
})

describe("errorDetail", () => {
  it("adds the App file tip when the keychain prompt was denied", () => {
    const denied = { kind: "credential" as const, message: "User canceled the operation." }
    expect(errorDetail(denied)).toBe(`User canceled the operation. ${KEYCHAIN_DENIED_TIP}`)
    expect(describeError(denied, "save")).toEqual({
      summary:
        "Couldn't save the connection. Credentials were rejected or couldn't be read from the keychain.",
      detail: `User canceled the operation. ${KEYCHAIN_DENIED_TIP}`,
    })
  })

  it("leaves other errors alone, including other kinds with the same text", () => {
    expect(errorDetail({ kind: "credential", message: "Access denied for user" })).toBe(
      "Access denied for user",
    )
    expect(errorDetail({ kind: "connection", message: "User canceled" })).toBe("User canceled")
  })
})
