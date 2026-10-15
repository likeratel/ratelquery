import { describe, expect, it } from "vitest"
import { formatShortcut, matchesShortcut, parseShortcut } from "./shortcuts"

const press = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "shift" | "alt", boolean>> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
})

describe("parseShortcut", () => {
  it("maps letters, digits and symbols to physical codes", () => {
    expect(parseShortcut("Mod+k").code).toBe("KeyK")
    expect(parseShortcut("Mod+1").code).toBe("Digit1")
    expect(parseShortcut("Mod+/").code).toBe("Slash")
    expect(parseShortcut("Mod+Shift+Enter")).toEqual({
      code: "Enter",
      mod: true,
      shift: true,
      alt: false,
    })
  })

  it("rejects unknown modifiers", () => {
    expect(() => parseShortcut("Hyper+K")).toThrow(/Unknown modifier/)
  })
})

describe("matchesShortcut", () => {
  const run = parseShortcut("Mod+Enter")

  it("matches on physical key regardless of IME layout", () => {
    // With a Korean layout active, `key` would be "ㅏ" for KeyK but `code` is stable.
    expect(matchesShortcut(press("KeyK", { meta: true }), parseShortcut("Mod+K"), true)).toBe(true)
    expect(matchesShortcut(press("Enter", { meta: true }), run, true)).toBe(true)
  })

  it("uses Ctrl outside macOS and rejects the wrong primary modifier", () => {
    expect(matchesShortcut(press("Enter", { ctrl: true }), run, false)).toBe(true)
    expect(matchesShortcut(press("Enter", { meta: true }), run, false)).toBe(false)
    expect(matchesShortcut(press("Enter", { ctrl: true }), run, true)).toBe(false)
  })

  it("requires exact modifier set", () => {
    expect(matchesShortcut(press("Enter", { meta: true, shift: true }), run, true)).toBe(false)
    expect(matchesShortcut(press("Enter"), run, true)).toBe(false)
  })
})

describe("formatShortcut", () => {
  it("renders platform specific labels", () => {
    expect(formatShortcut(parseShortcut("Mod+Shift+Enter"), true)).toBe("⇧⌘⏎")
    expect(formatShortcut(parseShortcut("Mod+K"), false)).toBe("Ctrl+K")
  })
})
