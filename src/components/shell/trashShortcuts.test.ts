import { describe, expect, it } from "vitest"
import { trashShortcutDecision } from "./trashShortcuts"

describe("trashShortcutDecision", () => {
  it("closes the Trash on Mod+W and ignores tab shortcuts", () => {
    expect(trashShortcutDecision("closeTab")).toBe("close-trash")
    for (const tabShortcut of [
      "runStatement",
      "runSelection",
      "apply",
      "newTab",
      "closeConnection",
      // The active tab isn't on screen, so there is nothing to reveal.
      "revealInSidebar",
    ] as const) {
      expect(trashShortcutDecision(tabShortcut)).toBe("ignore")
    }
    expect(trashShortcutDecision({ scope: "tab", slot: 2 })).toBe("ignore")
    expect(trashShortcutDecision({ scope: "connection", slot: 9 })).toBe("ignore")
  })

  it("lets the sidebar, Settings, zoom and other keys through", () => {
    expect(trashShortcutDecision("toggleSidebar")).toBe("pass")
    for (const zoom of ["in", "out", "reset"] as const) {
      expect(trashShortcutDecision({ zoom })).toBe("pass")
    }
    expect(trashShortcutDecision("settings")).toBe("pass")
    expect(trashShortcutDecision(null)).toBe("pass")
  })
})
