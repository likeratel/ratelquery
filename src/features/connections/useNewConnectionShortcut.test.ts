import { describe, expect, it } from "vitest"
import { newConnectionAction } from "./useNewConnectionShortcut"

const press = (patch: Partial<Parameters<typeof newConnectionAction>[0]> = {}) => ({
  code: "KeyN",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  ...patch,
})

describe("newConnectionAction", () => {
  it("opens the dialog on Mod+N", () => {
    expect(newConnectionAction(press(), false, true)).toBe("open")
  })

  it("swallows the shortcut while a modal is open", () => {
    expect(newConnectionAction(press(), true, true)).toBe("swallow")
  })

  it("ignores IME compositions, handled events, repeats and other keys", () => {
    expect(newConnectionAction(press({ isComposing: true }), false, true)).toBe("ignore")
    expect(newConnectionAction(press({ keyCode: 229, metaKey: false }), false, true)).toBe("ignore")
    // Mod+N reported as 229 mid-composition is still the shortcut.
    expect(newConnectionAction(press({ keyCode: 229 }), false, true)).toBe("open")
    expect(newConnectionAction(press({ defaultPrevented: true }), false, true)).toBe("ignore")
    expect(newConnectionAction(press({ repeat: true }), false, true)).toBe("ignore")
    expect(newConnectionAction(press({ code: "KeyM" }), false, true)).toBe("ignore")
  })
})
