import { describe, expect, it } from "vitest"
import { createTab, failRun, INITIAL_TABS, openTab, setExecutionId, startRun } from "./queryTabs"

describe("Athena query tabs", () => {
  it("opens with the engine it was asked for, MySQL by default", () => {
    const mysql = openTab(INITIAL_TABS, { id: "t1", connectionId: "c1", database: null })
    const athena = openTab(mysql, { id: "t2", connectionId: "a1", database: "x", engine: "athena" })
    expect(athena.tabs.map((t) => t.kind === "query" && t.engine)).toEqual(["mysql", "athena"])
  })

  it("records the execution only while the same run is going", () => {
    const running = startRun(createTab("t", "a1", "Query 1", null, "athena"))
    const withId = setExecutionId(running, running.runId, "e1")
    expect(withId.executionId).toBe("e1")
    expect(setExecutionId(withId, running.runId + 1, "e2")).toBe(withId)
    const failed = failRun(withId, "SELECT 1", { kind: "query", message: "x" })
    expect(failed.executionId).toBeNull()
    expect(setExecutionId(failed, running.runId, "late")).toBe(failed)
  })
})
