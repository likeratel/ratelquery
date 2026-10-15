import { describe, expect, it } from "vitest"
import { editorReturnTarget } from "./editorFocus"

describe("editorReturnTarget", () => {
  it("returns focus to Edit item when the editor closes with focus inside", () => {
    expect(editorReturnTarget(true, false, true, true)).toBe("edit")
  })

  it("falls back to New item when nothing is selected", () => {
    expect(editorReturnTarget(true, false, true, false)).toBe("new")
  })

  it("leaves focus alone otherwise", () => {
    expect(editorReturnTarget(true, false, false, true)).toBeNull()
    expect(editorReturnTarget(false, false, true, true)).toBeNull()
    expect(editorReturnTarget(true, true, true, true)).toBeNull()
  })
})
