import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionConfig } from "../lib/connections"
import type { OutputEntry, OutputFile, OutputLog } from "../lib/queryOutput"
import { DEFAULT_SETTINGS, mergeSettings } from "../lib/settings"
import { useConnectionsStore } from "./connectionsStore"
import { resetQueryOutputStore, useQueryOutputStore } from "./queryOutputStore"
import { createQueryOutputSync, type QueryOutputSync } from "./queryOutputSync"
import { useSettingsStore } from "./settingsStore"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 20, 12)

const connections: ConnectionConfig[] = [
  { kind: "mysql", id: "m1", name: "A", host: "h", port: 3306, user: "u" },
  { kind: "mysql", id: "m2", name: "B", host: "h", port: 3306, user: "u" },
]

const entry = (id: string, patch: Partial<OutputEntry> = {}): OutputEntry => ({
  id,
  connectionId: "m1",
  tabId: "t1",
  at: NOW,
  sql: `select '${id}'`,
  sqlTruncated: false,
  elapsedMs: 1,
  outcome: { kind: "rows", rowCount: 1, truncated: false },
  ...patch,
})

/** Fake backend file: `load` returns what was saved last; null removes it. */
class FakeFile {
  stored: OutputLog | null = null
  saves: (OutputFile | null)[] = []
  loads = 0
  warnings: string[] = []
  failLoad = false

  load = async () => {
    this.loads += 1
    if (this.failLoad) throw { kind: "io", message: "denied" }
    return this.stored ?? {}
  }
  save = async (file: OutputFile | null) => {
    this.saves.push(file)
    this.stored = file?.connections ?? null
  }
  warn = (message: string) => {
    this.warnings.push(message)
  }
}

let file: FakeFile
let sync: QueryOutputSync
let stop: () => void = () => {}
let beforeClose: (() => Promise<void>) | null = null

const settle = () => vi.advanceTimersByTimeAsync(0)

const setRetention = (days: number) => {
  const settings = mergeSettings(DEFAULT_SETTINGS, { query: { outputRetentionDays: days } })
  useSettingsStore.setState({ settings, saved: settings })
}

const ready = (days = 30) => {
  setRetention(days)
  useSettingsStore.setState({ status: "ready" })
  useConnectionsStore.setState({ connections, status: "ready" })
}

const ids = (log: OutputLog | null | undefined, id = "m1") => (log?.[id] ?? []).map((e) => e.id)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  file = new FakeFile()
  sync = createQueryOutputSync({
    load: () => file.load(),
    save: (f) => file.save(f),
    warn: file.warn,
    delayMs: 1000,
    now: () => NOW,
    onClose: (handler) => {
      beforeClose = handler
      return () => {
        beforeClose = null
      }
    },
  })
  resetQueryOutputStore()
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, status: "idle" })
  useConnectionsStore.setState({ connections: [], status: "idle" })
})

afterEach(() => {
  stop()
  stop = () => {}
  vi.useRealTimers()
})

describe("loading", () => {
  it("waits for settings and connections, then prunes old and orphaned entries", async () => {
    file.stored = {
      m1: [entry("old", { at: NOW - 31 * DAY }), entry("kept", { at: NOW - 29 * DAY })],
      deleted: [entry("orphan", { connectionId: "deleted" })],
    }
    stop = sync.start()
    useQueryOutputStore.getState().record([entry("early")])
    await vi.advanceTimersByTimeAsync(2000)
    expect(file.loads).toBe(0)
    expect(file.saves).toEqual([])

    ready(30)
    await settle()
    expect(file.loads).toBe(1)
    expect(ids(useQueryOutputStore.getState().log)).toEqual(["kept", "early"])
    expect(Object.keys(useQueryOutputStore.getState().log)).toEqual(["m1"])
    // The pruned log is written back at once.
    expect(ids(file.stored)).toEqual(["kept", "early"])
    expect(file.stored).not.toHaveProperty("deleted")
  })

  it("keeps a year when the setting says so", async () => {
    file.stored = { m1: [entry("old", { at: NOW - 200 * DAY })] }
    ready(365)
    stop = sync.start()
    await settle()
    expect(ids(useQueryOutputStore.getState().log)).toEqual(["old"])
  })

  it("turns saving off when the load fails", async () => {
    file.failLoad = true
    ready()
    stop = sync.start()
    await settle()
    useQueryOutputStore.getState().record([entry("a")])
    await vi.advanceTimersByTimeAsync(2000)
    expect(file.saves).toEqual([])
    expect(file.warnings).toEqual(["Couldn't load the saved query output"])
  })
})

describe("saving", () => {
  const startReady = async (days = 30) => {
    ready(days)
    stop = sync.start()
    await settle()
    file.saves = []
  }

  it("debounces new entries and saves the latest log", async () => {
    await startReady()
    const output = useQueryOutputStore.getState()
    output.record([entry("a")])
    await vi.advanceTimersByTimeAsync(600)
    output.record([entry("b", { connectionId: "m2" })])
    await vi.advanceTimersByTimeAsync(999)
    expect(file.saves).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(file.saves).toHaveLength(1)
    expect(file.saves[0]?.version).toBe(1)
    expect(ids(file.stored)).toEqual(["a"])
    expect(ids(file.stored, "m2")).toEqual(["b"])
  })

  it("prunes on save without dropping the session's view of older entries", async () => {
    await startReady()
    useQueryOutputStore.getState().record([entry("stale", { at: NOW - 40 * DAY }), entry("a")])
    await vi.advanceTimersByTimeAsync(1000)
    expect(ids(file.stored)).toEqual(["a"])
  })

  it("saves a deleted connection's removal", async () => {
    await startReady()
    useQueryOutputStore.getState().record([entry("a"), entry("b", { connectionId: "m2" })])
    await vi.advanceTimersByTimeAsync(1000)
    useQueryOutputStore.getState().forgetConnection("m1")
    await vi.advanceTimersByTimeAsync(1000)
    expect(file.stored).toEqual({ m2: [expect.objectContaining({ id: "b" })] })
  })

  it("removes the file when the retention becomes 0 and keeps the log in memory", async () => {
    await startReady()
    useQueryOutputStore.getState().record([entry("a")])
    await vi.advanceTimersByTimeAsync(1000)
    setRetention(0)
    await settle()
    expect(file.saves.at(-1)).toBeNull()
    expect(file.stored).toBeNull()
    useQueryOutputStore.getState().record([entry("b")])
    await vi.advanceTimersByTimeAsync(1000)
    expect(file.saves.at(-1)).toBeNull()
    expect(ids(useQueryOutputStore.getState().log)).toEqual(["a", "b"])
  })

  it("never loads with retention 0 and removes a leftover file", async () => {
    file.stored = { m1: [entry("leftover")] }
    await startReady(0)
    expect(file.loads).toBe(0)
    expect(file.stored).toBeNull()
    expect(useQueryOutputStore.getState().log).toEqual({})
  })

  it("writes a pending change when the window closes", async () => {
    await startReady()
    useQueryOutputStore.getState().record([entry("a")])
    await beforeClose?.()
    expect(ids(file.stored)).toEqual(["a"])
  })
})
