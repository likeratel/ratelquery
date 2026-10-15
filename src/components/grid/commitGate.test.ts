import { describe, expect, it } from "vitest"
import { commitOnce, type CommitGate } from "./commitGate"

describe("commitOnce", () => {
  it("commits once even when the commit triggers a re-entrant blur", () => {
    const gate: CommitGate = { done: false }
    const commits: string[] = []
    const handlers = {
      onCommit: (text: string) => {
        commits.push(text)
        // Closing the editor blurs the input, which commits again from inside this call.
        commitOnce(gate, text, "old", handlers)
        return null
      },
      onCancel: () => {},
    }
    expect(commitOnce(gate, "new", "old", handlers)).toBeNull()
    expect(commits).toEqual(["new"])
    expect(gate.done).toBe(true)
  })

  it("keeps the editor open after a rejected value", () => {
    const gate: CommitGate = { done: false }
    const handlers = { onCommit: () => "Not a number", onCancel: () => {} }
    expect(commitOnce(gate, "abc", "1", handlers)).toBe("Not a number")
    expect(gate.done).toBe(false)
  })

  it("cancels an unchanged value instead of committing it", () => {
    const gate: CommitGate = { done: false }
    let cancelled = 0
    const handlers = { onCommit: () => "unexpected", onCancel: () => cancelled++ }
    expect(commitOnce(gate, "same", "same", handlers)).toBeNull()
    expect(commitOnce(gate, "same", "same", handlers)).toBeNull()
    expect(cancelled).toBe(1)
  })
})
