import { describe, expect, it } from "vitest"
import { tabKeyTarget } from "./tabKeyboard"

const ids = ["a", "b", "c"]

describe("tabKeyTarget", () => {
  it("moves focus with the arrows and wraps", () => {
    expect(tabKeyTarget(ids, "a", "ArrowRight")).toEqual({ id: "b", activate: false })
    expect(tabKeyTarget(ids, "c", "ArrowRight")).toEqual({ id: "a", activate: false })
    expect(tabKeyTarget(ids, "a", "ArrowLeft")).toEqual({ id: "c", activate: false })
  })

  it("jumps to the ends", () => {
    expect(tabKeyTarget(ids, "b", "Home")).toEqual({ id: "a", activate: false })
    expect(tabKeyTarget(ids, "b", "End")).toEqual({ id: "c", activate: false })
  })

  it("activates the focused tab on Enter or Space", () => {
    expect(tabKeyTarget(ids, "b", "Enter")).toEqual({ id: "b", activate: true })
    expect(tabKeyTarget(ids, "b", "Space")).toEqual({ id: "b", activate: true })
  })

  it("ignores other keys and unknown tabs", () => {
    expect(tabKeyTarget(ids, "b", "KeyA")).toBeNull()
    expect(tabKeyTarget(ids, "x", "ArrowRight")).toBeNull()
    expect(tabKeyTarget([], null, "ArrowRight")).toBeNull()
  })
})
