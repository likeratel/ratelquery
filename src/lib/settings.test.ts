import { describe, expect, it } from "vitest"
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  parseNumericSetting,
  settingsSchema,
} from "./settings"

describe("settingsSchema", () => {
  it("accepts the defaults", () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
  })

  it("rejects values outside the contract ranges", () => {
    const bad = [
      mergeSettings(DEFAULT_SETTINGS, { editorFontSize: 10 }),
      mergeSettings(DEFAULT_SETTINGS, { editorFontSize: 21 }),
      mergeSettings(DEFAULT_SETTINGS, { query: { defaultLimit: 0 } }),
      mergeSettings(DEFAULT_SETTINGS, { query: { defaultLimit: 100_001 } }),
      mergeSettings(DEFAULT_SETTINGS, { query: { maxRows: 1.5 } }),
      mergeSettings(DEFAULT_SETTINGS, { dynamo: { pageSize: 1001 } }),
      { ...DEFAULT_SETTINGS, theme: "sepia" },
    ]
    for (const value of bad) expect(settingsSchema.safeParse(value).success).toBe(false)
  })
})

describe("normalizeSettings", () => {
  it("fills missing groups and fields from the defaults", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ dynamo: { pageSize: 25 }, extra: true })).toEqual(
      mergeSettings(DEFAULT_SETTINGS, { dynamo: { pageSize: 25 } }),
    )
  })
})

describe("mergeSettings", () => {
  it("merges groups without mutating the base", () => {
    const base = DEFAULT_SETTINGS
    const next = mergeSettings(base, { query: { confirmDestructive: false } })
    expect(next.query).toEqual({ ...base.query, confirmDestructive: false })
    expect(base.query.confirmDestructive).toBe(true)
    expect(next.dynamo).toEqual(base.dynamo)
  })
})

describe("parseNumericSetting", () => {
  it("accepts whole numbers inside the range", () => {
    expect(parseNumericSetting("editorFontSize", " 14 ")).toEqual({ ok: true, value: 14 })
    expect(parseNumericSetting("pageSize", "1000")).toEqual({ ok: true, value: 1000 })
  })

  it("explains what is allowed", () => {
    for (const text of ["", "abc", "1e3", "2.5", "-1", "0"]) {
      expect(parseNumericSetting("defaultLimit", text)).toEqual({
        ok: false,
        error: "Enter a whole number from 1 to 100,000",
      })
    }
    expect(parseNumericSetting("editorFontSize", "21")).toMatchObject({ ok: false })
  })
})
