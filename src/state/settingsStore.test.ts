import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useToastStore } from "../components/ui/toastStore"
import { setTransport, type AppError } from "../lib/ipc"
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../lib/settings"
import { resetSettingsStore, useSettingsStore } from "./settingsStore"

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Deep merge like the backend's `settings_set`: objects key by key, anything else replaced. */
function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isObject(base) || !isObject(overlay)) return overlay
  return Object.entries(overlay).reduce<Record<string, unknown>>(
    (acc, [key, value]) => ({ ...acc, [key]: key in acc ? deepMerge(acc[key], value) : value }),
    { ...base },
  )
}

/** In-memory stand-in for the backend's settings commands. */
class FakeSettingsBackend {
  stored: unknown = DEFAULT_SETTINGS
  failures = new Map<string, AppError>()
  calls: { command: string; args?: Record<string, unknown> }[] = []
  private pending: (() => void)[] = []
  hold = false

  transport = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    this.calls = [...this.calls, { command, args }]
    if (this.hold) await new Promise<void>((resolve) => this.pending.push(resolve))
    const failure = this.failures.get(command)
    if (failure) throw failure
    switch (command) {
      case "settings_get":
        return this.stored
      case "settings_set":
        this.stored = deepMerge(this.stored, args?.settings)
        return this.stored
      default:
        throw { kind: "unknown", message: `unexpected ${command}` }
    }
  }

  release() {
    this.hold = false
    const pending = this.pending
    this.pending = []
    pending.forEach((resolve) => resolve())
  }
}

let backend: FakeSettingsBackend
let restore: () => void
const store = () => useSettingsStore.getState()

beforeEach(() => {
  backend = new FakeSettingsBackend()
  restore = setTransport(backend.transport)
  resetSettingsStore()
  useToastStore.setState({ toasts: [] })
})

afterEach(() => restore())

describe("load", () => {
  it("loads the stored settings", async () => {
    const stored: Settings = mergeSettings(DEFAULT_SETTINGS, {
      theme: "light",
      query: { defaultLimit: 50 },
    })
    backend.stored = stored
    await store().load()
    expect(store().status).toBe("ready")
    expect(store().settings).toEqual(stored)
    expect(store().saved).toEqual(stored)
  })

  it("defaults fields the backend sent invalid or missing", async () => {
    backend.stored = { theme: "neon", editorFontSize: 99, query: { maxRows: 5000 } }
    await store().load()
    expect(store().settings).toEqual(mergeSettings(DEFAULT_SETTINGS, { query: { maxRows: 5000 } }))
  })

  it("keeps the defaults when the backend is unavailable", async () => {
    backend.failures.set("settings_get", { kind: "io", message: "EACCES" })
    await store().load()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(store().loadError).toBe("EACCES")
    expect(store().status).toBe("ready")
  })

  it("keeps stored values when a change is saved before the load answers", async () => {
    const stored = mergeSettings(DEFAULT_SETTINGS, { editorFontSize: 16, theme: "light" })
    backend.stored = stored
    backend.hold = true
    const loading = store().load()
    const saving = store().update({ query: { addLimitToSelect: false } })
    backend.release()
    await Promise.all([loading, saving])
    const expected = mergeSettings(stored, { query: { addLimitToSelect: false } })
    expect(backend.stored).toEqual(expected)
    expect(store().settings).toEqual(expected)
    expect(store().saved).toEqual(expected)
  })

  it("keeps stored values when the save answers before the load", async () => {
    backend.stored = mergeSettings(DEFAULT_SETTINGS, { editorFontSize: 16, theme: "light" })
    backend.hold = true
    const loading = store().load()
    backend.hold = false
    await store().update({ query: { addLimitToSelect: false } })
    backend.release()
    await loading
    expect(store().settings).toMatchObject({
      editorFontSize: 16,
      theme: "light",
      query: { addLimitToSelect: false },
    })
  })

  it("doesn't overwrite a change made while loading", async () => {
    backend.hold = true
    const loading = store().load()
    backend.hold = false
    await store().update({ theme: "dark" })
    backend.release()
    await loading
    expect(store().settings.theme).toBe("dark")
  })
})

describe("update", () => {
  it("applies the change at once and sends only the patch", async () => {
    backend.hold = true
    const saving = store().update({ editorFontSize: 16, query: { addLimitToSelect: false } })
    expect(store().settings.editorFontSize).toBe(16)
    expect(store().saved.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
    backend.release()
    expect(await saving).toBe(true)
    const expected = mergeSettings(DEFAULT_SETTINGS, {
      editorFontSize: 16,
      query: { addLimitToSelect: false },
    })
    expect(backend.calls.at(-1)).toEqual({
      command: "settings_set",
      args: { settings: { editorFontSize: 16, query: { addLimitToSelect: false } } },
    })
    expect(store().saved).toEqual(expected)
    expect(store().settings.query.defaultLimit).toBe(DEFAULT_SETTINGS.query.defaultLimit)
  })

  it("rolls back and reports a failed save", async () => {
    backend.failures.set("settings_set", { kind: "invalid_input", message: "maxRows out of range" })
    expect(await store().update({ theme: "light" })).toBe(false)
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(useToastStore.getState().toasts).toMatchObject([
      { tone: "error", message: "Couldn't save settings", detail: "maxRows out of range" },
    ])
  })

  it("rolls back to the loaded value when a save made before the load fails", async () => {
    backend.stored = mergeSettings(DEFAULT_SETTINGS, { theme: "light" })
    backend.failures.set("settings_set", { kind: "io", message: "disk full" })
    backend.hold = true
    const loading = store().load()
    const saving = store().update({ editorFontSize: 18 })
    backend.release()
    expect(await saving).toBe(false)
    await loading
    expect(store().settings).toEqual(backend.stored)
  })

  it("refuses out-of-range values without calling the backend", async () => {
    expect(await store().update({ editorFontSize: 40 })).toBe(false)
    expect(store().settings.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
    expect(backend.calls).toEqual([])
  })
})
