import { describe, expect, it, vi } from "vitest"
import { emitAppEvent, onAppEvent } from "./events"

describe("app events", () => {
  it("delivers payloads until the listener unsubscribes", () => {
    const seen: string[] = []
    const off = onAppEvent("connection-removed", (id) => seen.push(id))
    emitAppEvent("connection-removed", "c1")
    off()
    emitAppEvent("connection-removed", "c2")
    expect(seen).toEqual(["c1"])
  })

  it("keeps notifying other listeners when one throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const seen: string[] = []
    const offBad = onAppEvent("connection-removed", () => {
      throw new Error("boom")
    })
    const offGood = onAppEvent("connection-removed", (id) => seen.push(id))
    emitAppEvent("connection-removed", "c1")
    expect(seen).toEqual(["c1"])
    expect(error).toHaveBeenCalled()
    offBad()
    offGood()
    error.mockRestore()
  })
})
