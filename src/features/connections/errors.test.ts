import { describe, expect, it } from "vitest"
import type { AppErrorKind } from "../../lib/ipc"
import { describeError } from "./errors"

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
      expect(s.summary.startsWith("Could not save the connection.")).toBe(true)
      expect(s.detail).toBe("raw")
    })
  })

  it("branches on kind, not message text", () => {
    const a = describeError({ kind: "credential", message: "connection refused" }, "load")
    expect(a.summary).toContain("Credentials were rejected")
  })

  it("uses a direct sentence for failed connection tests", () => {
    expect(describeError({ kind: "connection", message: "timeout" }, "test")).toEqual({
      summary: "Could not reach the server. Check the host, port and network.",
      detail: "timeout",
    })
    expect(describeError({ kind: "credential", message: "denied" }, "test").summary).toBe(
      "Connection test failed. Credentials were rejected or could not be read from the keychain.",
    )
  })
})
