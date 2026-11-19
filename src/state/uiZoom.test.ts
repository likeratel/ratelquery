import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setTransport } from "../lib/ipc"
import { DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from "../lib/settings"
import { applyUiZoom, resetSettingsStore, useSettingsStore } from "./settingsStore"
import {
  flushUiZoom,
  resetUiZoom,
  setUiZoom,
  shownUiZoom,
  startUiZoomSync,
  stepUiZoom,
  ZOOM_SAVE_DELAY_MS,
} from "./uiZoom"

// The webview zoom needs the desktop shell; the tests only check which levels were applied.
vi.mock("./settingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsStore")>()),
  applyUiZoom: vi.fn(),
}))

let saved: SettingsPatch[]
let failNext: boolean
let restore: () => void
const uiZoom = () => useSettingsStore.getState().settings.uiZoom
const applied = () => vi.mocked(applyUiZoom).mock.calls.map(([level]) => level)

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(applyUiZoom).mockClear()
  resetUiZoom()
  resetSettingsStore()
  useSettingsStore.setState({ status: "ready" })
  saved = []
  failNext = false
  let stored = DEFAULT_SETTINGS
  restore = setTransport(async (command, args) => {
    if (command !== "settings_set") throw { kind: "unknown", message: command }
    const patch = args?.settings as SettingsPatch
    saved = [...saved, patch]
    if (failNext) {
      failNext = false
      throw { kind: "io", message: "disk full" }
    }
    stored = mergeSettings(stored, patch)
    return stored
  })
})

afterEach(() => {
  restore()
  vi.useRealTimers()
})

describe("setUiZoom", () => {
  it("drops a step still waiting, which would otherwise land after the picked level", async () => {
    stepUiZoom("in")
    expect(shownUiZoom()).toBe(110)
    await setUiZoom(90)
    await vi.runAllTimersAsync()
    expect(saved).toEqual([{ uiZoom: 90 }])
    expect(uiZoom()).toBe(90)
    expect(shownUiZoom()).toBe(90)
  })

  it("leaves the next step to start from the picked level", async () => {
    stepUiZoom("in")
    await setUiZoom(90)
    expect(stepUiZoom("in")).toBe(100)
    await vi.runAllTimersAsync()
    expect(saved).toEqual([{ uiZoom: 90 }, { uiZoom: 100 }])
    expect(uiZoom()).toBe(100)
  })
})

describe("flushUiZoom", () => {
  it("saves a waiting step at once and only once", async () => {
    stepUiZoom("in")
    await flushUiZoom()
    expect(saved).toEqual([{ uiZoom: 110 }])
    await vi.advanceTimersByTimeAsync(ZOOM_SAVE_DELAY_MS)
    expect(saved).toEqual([{ uiZoom: 110 }])
  })

  it("does nothing without a waiting step", async () => {
    await flushUiZoom()
    expect(saved).toEqual([])
  })
})

describe("startUiZoomSync", () => {
  it("applies the saved level once settings are ready and when it changes", async () => {
    useSettingsStore.setState({ status: "loading" })
    const stop = startUiZoomSync(() => () => {})
    expect(applied()).toEqual([])
    useSettingsStore.setState({
      status: "ready",
      settings: { ...DEFAULT_SETTINGS, uiZoom: 125 },
    })
    expect(applied()).toEqual([125])
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, uiZoom: 125, theme: "dark" } })
    expect(applied()).toEqual([125])
    await setUiZoom(90)
    expect(applied()).toEqual([125, 90])
    stop()
  })

  it("doesn't flash an older level back when a save fails under a newer waiting step", async () => {
    const stop = startUiZoomSync(() => () => {})
    stepUiZoom("in")
    failNext = true
    const failing = flushUiZoom()
    // 110 is on its way to the backend when the next step comes.
    stepUiZoom("in")
    await failing
    expect(uiZoom()).toBe(DEFAULT_SETTINGS.uiZoom)
    // Started at 100; the rollback to 100 under the waiting 125 is not applied.
    expect(applied()).toEqual([100, 110, 110, 125])
    await vi.runAllTimersAsync()
    expect(saved).toEqual([{ uiZoom: 110 }, { uiZoom: 125 }])
    expect(uiZoom()).toBe(125)
    expect(applied().at(-1)).toBe(125)
    stop()
  })

  it("saves a waiting step when the window closes", async () => {
    let beforeClose: (() => Promise<void>) | null = null
    const off = vi.fn()
    const stop = startUiZoomSync((callback) => {
      beforeClose = callback
      return off
    })
    stepUiZoom("in")
    await beforeClose!()
    expect(saved).toEqual([{ uiZoom: 110 }])
    stop()
    expect(off).toHaveBeenCalled()
  })
})
