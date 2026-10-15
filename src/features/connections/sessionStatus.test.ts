import { describe, expect, it } from "vitest"
import { emptySession, noteRecovery, reduceStateEvent } from "../../state/sessionsStore"
import { hasNewRecovery, sessionStatus } from "./sessionStatus"

const event = (state: "connected" | "reconnecting" | "error", message?: string) => ({
  connectionId: "c1",
  state,
  message,
})

describe("sessionStatus", () => {
  it("shows nothing without a live session", () => {
    expect(sessionStatus(undefined)).toBeNull()
    expect(sessionStatus(emptySession())).toBeNull()
  })

  it("names the server while connected", () => {
    const session = { ...emptySession(), state: "connected" as const, serverVersion: "8.0.36" }
    expect(sessionStatus(session)).toEqual({
      state: "connected",
      label: "Connected · MySQL 8.0.36",
    })
  })

  it("carries the last error in the tooltip", () => {
    const failed = reduceStateEvent(emptySession(), event("error", "Lost connection"))
    expect(sessionStatus(failed)).toEqual({
      state: "error",
      label: "Connection error\nLost connection",
    })
    const reconnecting = reduceStateEvent(failed, event("reconnecting"))
    expect(sessionStatus(reconnecting)?.label).toBe("Reconnecting…\nLost connection")
  })
})

describe("hasNewRecovery", () => {
  it("ripples once per recovery counted after the row mounted", () => {
    const reconnecting = reduceStateEvent(
      { ...emptySession(), state: "connected" },
      event("reconnecting"),
    )
    const recovered = reduceStateEvent(reconnecting, event("connected"), 1000)
    expect(hasNewRecovery(recovered, 0)).toBe(true)
    expect(hasNewRecovery(recovered, recovered.reconnects)).toBe(false)
    // The query result reporting the same recovery doesn't ripple again.
    const reported = noteRecovery(recovered, "result", 1500)
    expect(hasNewRecovery(reported, recovered.reconnects)).toBe(false)
  })
})
