import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useToastStore } from "../../components/ui/toastStore"
import { setTransport } from "../../lib/ipc"
import { INITIAL_TABS } from "../../lib/queryTabs"
import { DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from "../../lib/settings"
import { isMac, type KeyLike } from "../../lib/shortcuts"
import { applyUiZoom, resetSettingsStore, useSettingsStore } from "../../state/settingsStore"
import { useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"
import { resetUiZoom, ZOOM_SAVE_DELAY_MS } from "../../state/uiZoom"
import { handleAppShortcut, isZoomShortcut, matchAppShortcut } from "./appShortcuts"

// The webview zoom needs the desktop shell; the tests only check which levels were applied.
vi.mock("../../state/settingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/settingsStore")>()),
  applyUiZoom: vi.fn(),
}))

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
    expect(matchAppShortcut(modKey("Digit0"))).toEqual({ zoom: "reset" })
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

  it("matches browser zoom keys by physical key", () => {
    expect(matchAppShortcut(modKey("Equal"))).toEqual({ zoom: "in" })
    expect(matchAppShortcut(modKey("Equal", { shiftKey: true }))).toEqual({ zoom: "in" })
    expect(matchAppShortcut(modKey("NumpadAdd"))).toEqual({ zoom: "in" })
    expect(matchAppShortcut(modKey("Minus"))).toEqual({ zoom: "out" })
    expect(matchAppShortcut(modKey("NumpadSubtract"))).toEqual({ zoom: "out" })
    expect(matchAppShortcut(modKey("Numpad0"))).toEqual({ zoom: "reset" })
    expect(matchAppShortcut(modKey("Digit0", { altKey: true }))).toBeNull()
    expect(matchAppShortcut({ ...modKey("Equal"), metaKey: false, ctrlKey: false })).toBeNull()
  })

  it("tells zoom keys apart from the other shortcuts", () => {
    expect(isZoomShortcut(modKey("Equal"))).toBe(true)
    expect(isZoomShortcut(modKey("Minus"))).toBe(true)
    expect(isZoomShortcut(modKey("Digit0"))).toBe(true)
    expect(isZoomShortcut(modKey("Comma"))).toBe(false)
    expect(isZoomShortcut(modKey("Digit1"))).toBe(false)
  })
})

describe("zoom shortcuts", () => {
  let saved: SettingsPatch[]
  let restore: () => void
  const uiZoom = () => useSettingsStore.getState().settings.uiZoom
  const applied = () => vi.mocked(applyUiZoom).mock.calls.map(([level]) => level)
  const toasts = () => useToastStore.getState().toasts.map((t) => t.message)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(applyUiZoom).mockClear()
    resetUiZoom()
    resetSettingsStore()
    useSettingsStore.setState({ status: "ready" })
    saved = []
    let stored = DEFAULT_SETTINGS
    restore = setTransport(async (command, args) => {
      if (command !== "settings_set") throw { kind: "unknown", message: command }
      const patch = args?.settings as SettingsPatch
      saved = [...saved, patch]
      stored = mergeSettings(stored, patch)
      return stored
    })
  })

  afterEach(() => {
    restore()
    vi.useRealTimers()
  })

  it("applies each step at once, shows one toast and saves only the newest level", async () => {
    handleAppShortcut(modKey("Equal"))
    handleAppShortcut(modKey("Equal"))
    expect(applied()).toEqual([110, 125])
    expect(toasts()).toEqual(["Zoom 125%"])
    await vi.advanceTimersByTimeAsync(ZOOM_SAVE_DELAY_MS - 1)
    expect(saved).toEqual([])
    // Another press pushes the save back again.
    handleAppShortcut(modKey("Equal"))
    await vi.advanceTimersByTimeAsync(ZOOM_SAVE_DELAY_MS - 1)
    expect(saved).toEqual([])
    expect(uiZoom()).toBe(100)
    await vi.advanceTimersByTimeAsync(1)
    expect(saved).toEqual([{ uiZoom: 150 }])
    expect(uiZoom()).toBe(150)
    expect(toasts()).toEqual(["Zoom 150%"])
  })

  it("steps from the unsaved level and doesn't save one that ends where it started", async () => {
    handleAppShortcut(modKey("Equal"))
    handleAppShortcut(modKey("Minus"))
    expect(applied()).toEqual([110, 100])
    await vi.runAllTimersAsync()
    expect(saved).toEqual([])
    expect(uiZoom()).toBe(100)
  })

  it("resets to 100% from a saved level", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, uiZoom: 150 } })
    handleAppShortcut(modKey("Digit0"))
    expect(applied()).toEqual([100])
    await vi.runAllTimersAsync()
    expect(saved).toEqual([{ uiZoom: 100 }])
  })

  it("claims a zoom key at either end without applying or saving again", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, uiZoom: 80 } })
    expect(handleAppShortcut(modKey("Minus"))).toBe(true)
    expect(toasts()).toEqual(["Zoom 80%"])
    await vi.runAllTimersAsync()
    expect(applied()).toEqual([])
    expect(saved).toEqual([])
    expect(uiZoom()).toBe(80)
  })

  it("claims a zoom key before the saved settings load but doesn't step from the defaults", async () => {
    useSettingsStore.setState({ status: "loading" })
    expect(handleAppShortcut(modKey("Equal"))).toBe(true)
    await vi.runAllTimersAsync()
    expect(applied()).toEqual([])
    expect(toasts()).toEqual([])
    expect(saved).toEqual([])
  })

  it("keeps zooming while the key is held", async () => {
    expect(handleAppShortcut(modKey("Equal"))).toBe(true)
    expect(handleAppShortcut(modKey("Equal", { repeat: true }))).toBe(true)
    expect(handleAppShortcut(modKey("Equal", { repeat: true }))).toBe(true)
    expect(applied()).toEqual([110, 125, 150])
    await vi.runAllTimersAsync()
    expect(saved).toEqual([{ uiZoom: 150 }])
  })
})
