import { describe, expect, it } from "vitest"
import { ipc, normalizeError, setTransport } from "./ipc"

describe("normalizeError", () => {
  it("keeps structured backend errors", () => {
    expect(normalizeError({ kind: "query", message: "syntax" })).toEqual({
      kind: "query",
      message: "syntax",
    })
  })

  it("maps unknown kinds to unknown", () => {
    expect(normalizeError({ kind: "weird", message: "x" }).kind).toBe("unknown")
  })

  it("wraps strings and Errors", () => {
    expect(normalizeError("boom")).toEqual({ kind: "unknown", message: "boom" })
    expect(normalizeError(new Error("bad"))).toEqual({ kind: "unknown", message: "bad" })
  })
})

describe("ipc", () => {
  it("passes through results and normalizes rejections", async () => {
    const restore = setTransport(async (command) => {
      if (command === "ok") return 42
      throw { kind: "connection", message: "down" }
    })
    try {
      await expect(ipc<number>("ok")).resolves.toBe(42)
      await expect(ipc("fail")).rejects.toEqual({ kind: "connection", message: "down" })
    } finally {
      restore()
    }
  })
})
