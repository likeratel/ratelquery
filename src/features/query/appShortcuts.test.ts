import { beforeEach, describe, expect, it } from "vitest"
import { useToastStore } from "../../components/ui/toastStore"
import { INITIAL_TABS } from "../../lib/queryTabs"
import { isMac, type KeyLike } from "../../lib/shortcuts"
import { useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"
import { handleAppShortcut, matchAppShortcut } from "./appShortcuts"

function modKey(code: string, extra: Partial<KeyLike> = {}): KeyLike {
  const mac = isMac()
  return { code, metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false, ...extra }
}

beforeEach(() => {
  useTabsStore.setState({ ...INITIAL_TABS })
  useToastStore.setState({ toasts: [] })
})

describe("handleAppShortcut", () => {
  it("prefers the longer Enter combination", () => {
    expect(matchAppShortcut(modKey("Enter", { shiftKey: true }))).toBe("runSelection")
    expect(matchAppShortcut(modKey("NumpadEnter"))).toBe("runStatement")
    expect(matchAppShortcut(modKey("KeyX"))).toBeNull()
  })

  it("opens settings on Mod+, by physical key", () => {
    useUiStore.setState({ settingsOpen: false })
    expect(matchAppShortcut(modKey("Comma"))).toBe("settings")
    expect(handleAppShortcut(modKey("Comma"))).toBe(true)
    expect(useUiStore.getState().settingsOpen).toBe(true)
  })

  it("matches Mod+1..9 to tabs and Mod+Alt+1..9 to connections by physical digit", () => {
    expect(matchAppShortcut(modKey("Digit1"))).toEqual({ scope: "tab", slot: 1 })
    expect(matchAppShortcut(modKey("Digit9"))).toEqual({ scope: "tab", slot: 9 })
    expect(matchAppShortcut(modKey("Digit3", { altKey: true }))).toEqual({
      scope: "connection",
      slot: 3,
    })
    expect(matchAppShortcut(modKey("Digit0"))).toBeNull()
    expect(matchAppShortcut(modKey("Numpad1"))).toBeNull()
    expect(matchAppShortcut(modKey("Digit1", { shiftKey: true }))).toBeNull()
    expect(matchAppShortcut({ ...modKey("Digit1"), metaKey: false, ctrlKey: false })).toBeNull()
  })

  it("switches tabs within the connection and between connections", () => {
    const store = useTabsStore.getState()
    const a1 = store.open("a", null)
    const a2 = store.open("a", null)
    const b1 = store.open("b", null)
    expect(handleAppShortcut(modKey("Digit1"))).toBe(true)
    expect(useTabsStore.getState().activeId).toBe(b1)
    expect(handleAppShortcut(modKey("Digit1", { altKey: true }))).toBe(true)
    expect(useTabsStore.getState().activeId).toBe(a2)
    handleAppShortcut(modKey("Digit1"))
    expect(useTabsStore.getState().activeId).toBe(a1)
    handleAppShortcut(modKey("Digit9", { altKey: true }))
    expect(useTabsStore.getState().activeId).toBe(b1)
    // A number past the end is still claimed (the editor mustn't type it) but does nothing.
    expect(handleAppShortcut(modKey("Digit5"))).toBe(true)
    expect(useTabsStore.getState().activeId).toBe(b1)
  })

  it("claims a held shortcut without running it again", () => {
    expect(handleAppShortcut(modKey("KeyT", { repeat: true }))).toBe(true)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(handleAppShortcut(modKey("KeyT"))).toBe(true)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "Open a connection from the sidebar first",
    ])
  })
})
