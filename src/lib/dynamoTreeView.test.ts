import { describe, expect, it } from "vitest"
import { startsTreeEdit, treeFieldKey } from "./dynamoTreeView"

const press = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "shift" | "alt" | "composing", boolean>> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  isComposing: mods.composing ?? false,
})

describe("startsTreeEdit", () => {
  it("opens a value's field on bare Enter, keypad Enter and F2", () => {
    for (const mac of [true, false]) {
      expect(startsTreeEdit(press("Enter"), mac)).toBe(true)
      expect(startsTreeEdit(press("NumpadEnter"), mac)).toBe(true)
      expect(startsTreeEdit(press("F2"), mac)).toBe(true)
    }
  })

  it("leaves Enter with a modifier to the app, so Run still fires", () => {
    expect(startsTreeEdit(press("Enter", { meta: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { ctrl: true }), false)).toBe(false)
    expect(startsTreeEdit(press("Enter", { ctrl: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { meta: true, shift: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { shift: true }), true)).toBe(false)
    expect(startsTreeEdit(press("Enter", { alt: true }), true)).toBe(false)
    expect(startsTreeEdit(press("F2", { meta: true }), true)).toBe(false)
    expect(startsTreeEdit(press("F2", { shift: true }), false)).toBe(false)
  })

  it("leaves a key that ends an IME composition to the IME", () => {
    expect(startsTreeEdit(press("Enter", { composing: true }), true)).toBe(false)
    expect(startsTreeEdit(press("F2", { composing: true }), true)).toBe(false)
  })

  it("ignores other keys", () => {
    expect(startsTreeEdit(press("KeyE"), true)).toBe(false)
    expect(startsTreeEdit(press("Space"), true)).toBe(false)
  })
})

describe("treeFieldKey", () => {
  it("commits on bare Enter and cancels on Esc", () => {
    for (const mac of [true, false]) {
      expect(treeFieldKey(press("Enter"), mac)).toBe("commit")
      expect(treeFieldKey(press("NumpadEnter"), mac)).toBe("commit")
      expect(treeFieldKey(press("Escape"), mac)).toBe("cancel")
    }
  })

  it("never commits or closes the field while a Korean or Japanese composition is open", () => {
    expect(treeFieldKey(press("Enter", { composing: true }), true)).toBe("composing")
    expect(treeFieldKey(press("NumpadEnter", { composing: true }), false)).toBe("composing")
    expect(treeFieldKey(press("Escape", { composing: true }), true)).toBe("composing")
  })

  it("leaves Enter with Mod or Ctrl held to the app's shortcuts", () => {
    expect(treeFieldKey(press("Enter", { meta: true }), true)).toBeNull()
    expect(treeFieldKey(press("Enter", { ctrl: true }), true)).toBeNull()
    expect(treeFieldKey(press("Enter", { ctrl: true }), false)).toBeNull()
    expect(treeFieldKey(press("Enter", { meta: true }), false)).toBeNull()
    expect(treeFieldKey(press("Enter", { meta: true, shift: true }), true)).toBeNull()
    expect(treeFieldKey(press("Escape", { meta: true }), true)).toBeNull()
  })

  it("ignores typing", () => {
    expect(treeFieldKey(press("KeyA"), true)).toBeNull()
    expect(treeFieldKey(press("KeyA", { shift: true }), true)).toBeNull()
  })
})
