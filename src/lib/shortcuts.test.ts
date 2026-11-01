import { describe, expect, it } from "vitest"
import { formatShortcut, isImeComposing, matchesShortcut, parseShortcut } from "./shortcuts"

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

describe("isImeComposing", () => {
  it("marks keys of an open composition", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true)
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true)
  })

  it("marks the WebKit keydown that ends a composition after compositionend", () => {
    // Safari / WKWebView (WebKit bug 165004): isComposing is already false, keyCode is 229.
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it("leaves ordinary keys alone, with or without a keyCode", () => {
    expect(isImeComposing({ isComposing: false })).toBe(false)
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
    expect(isImeComposing({ isComposing: false, keyCode: 27 })).toBe(false)
  })
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

  it("parses Mod+Alt digits and matches them by code, whatever Alt types", () => {
    const shortcut = parseShortcut("Mod+Alt+1")
    expect(shortcut).toEqual({ code: "Digit1", mod: true, shift: false, alt: true })
    // On macOS Option+1 produces "¡"; only the physical key counts.
    expect(matchesShortcut(press("Digit1", { meta: true, alt: true }), shortcut, true)).toBe(true)
    expect(matchesShortcut(press("Digit1", { meta: true }), shortcut, true)).toBe(false)
    // Outside macOS, AltGr (reported as Ctrl+Alt) types characters and is left alone.
    const ctrlAlt = press("Digit8", { ctrl: true, alt: true })
    const altGr = { ...ctrlAlt, getModifierState: (key: string) => key === "AltGraph" }
    expect(matchesShortcut(ctrlAlt, parseShortcut("Mod+Alt+8"), false)).toBe(true)
    expect(matchesShortcut(altGr, parseShortcut("Mod+Alt+8"), false)).toBe(false)
    expect(formatShortcut(shortcut, true)).toBe("⌥⌘1")
    expect(formatShortcut(shortcut, false)).toBe("Ctrl+Alt+1")
  })

  it("rejects characters that need Shift to type", () => {
    expect(() => parseShortcut("Mod+?")).toThrow(/Unsupported key/)
  })

  it("accepts the keypad Enter for Enter shortcuts", () => {
    expect(
      matchesShortcut(press("NumpadEnter", { meta: true }), parseShortcut("Mod+Enter"), true),
    ).toBe(true)
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
