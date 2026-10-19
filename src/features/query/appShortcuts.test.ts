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

  it("claims a held shortcut without running it again", () => {
    expect(handleAppShortcut(modKey("KeyT", { repeat: true }))).toBe(true)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(handleAppShortcut(modKey("KeyT"))).toBe(true)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "Open a connection from the sidebar first",
    ])
  })
})
