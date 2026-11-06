import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

  /** Lets one held request through, by the order it arrived in, leaving the rest held. */
  releaseOne(index: number) {
    const resolve = this.pending[index]
    this.pending = this.pending.filter((_, i) => i !== index)
    resolve?.()
  }
}

/** Lets queued promise callbacks run, so a request that is free to go has been sent. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  it("sends a change made while loading only after the load answered", async () => {
    backend.stored = mergeSettings(DEFAULT_SETTINGS, { editorFontSize: 16, theme: "light" })
    backend.hold = true
    const loading = store().load()
    const saving = store().update({ query: { addLimitToSelect: false } })
    await settle()
    expect(backend.calls.map((c) => c.command)).toEqual(["settings_get"])
    backend.release()
    await Promise.all([loading, saving])
    expect(backend.calls.map((c) => c.command)).toEqual(["settings_get", "settings_set"])
    expect(store().settings).toMatchObject({
      editorFontSize: 16,
      theme: "light",
      query: { addLimitToSelect: false },
    })
  })

  it("doesn't overwrite a change made while loading", async () => {
    backend.hold = true
    const loading = store().load()
    const saving = store().update({ theme: "dark" })
    expect(store().settings.theme).toBe("dark")
    backend.release()
    await Promise.all([loading, saving])
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

  it("sends one save at a time, so the newest change is the one that lands", async () => {
    backend.hold = true
    const first = store().update({ uiZoom: 110 })
    const second = store().update({ uiZoom: 125 })
    expect(store().settings.uiZoom).toBe(125)
    await settle()
    expect(backend.calls).toHaveLength(1)
    backend.releaseOne(0)
    expect(await first).toBe(true)
    // The newer change still saving stays applied over the older answer.
    expect(store().saved.uiZoom).toBe(110)
    expect(store().settings.uiZoom).toBe(125)
    await vi.waitFor(() => expect(backend.calls).toHaveLength(2))
    backend.releaseOne(0)
    expect(await second).toBe(true)
    expect(store().settings.uiZoom).toBe(125)
    expect(backend.stored).toMatchObject({ uiZoom: 125 })
  })

  it("keeps a pending change to another field while an earlier save answers", async () => {
    backend.hold = true
    const zoom = store().update({ uiZoom: 125 })
    const theme = store().update({ theme: "dark" })
    await vi.waitFor(() => expect(backend.calls).toHaveLength(1))
    backend.releaseOne(0)
    await zoom
    expect(store().settings).toMatchObject({ uiZoom: 125, theme: "dark" })
    await vi.waitFor(() => expect(backend.calls).toHaveLength(2))
    backend.release()
    await theme
    expect(store().settings).toMatchObject({ uiZoom: 125, theme: "dark" })
    expect(store().saved).toMatchObject({ uiZoom: 125, theme: "dark" })
    expect(backend.stored).toMatchObject({ uiZoom: 125, theme: "dark" })
  })

  it("rolls a failed save back under a newer change that is still pending", async () => {
    backend.hold = true
    const first = store().update({ uiZoom: 110 })
    const second = store().update({ uiZoom: 125 })
    backend.failures.set("settings_set", { kind: "io", message: "disk full" })
    await vi.waitFor(() => expect(backend.calls).toHaveLength(1))
    backend.releaseOne(0)
    expect(await first).toBe(false)
    expect(store().settings.uiZoom).toBe(125)
    backend.failures.clear()
    await vi.waitFor(() => expect(backend.calls).toHaveLength(2))
    backend.release()
    expect(await second).toBe(true)
    expect(store().settings.uiZoom).toBe(125)
  })

  it("refuses out-of-range values without calling the backend", async () => {
    expect(await store().update({ editorFontSize: 40 })).toBe(false)
    expect(store().settings.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
    expect(backend.calls).toEqual([])
  })
})
