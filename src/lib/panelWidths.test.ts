import { describe, expect, it } from "vitest"
import {
  clampWidth,
  defaultPanelWidths,
  dragWidth,
  loadPanelWidths,
  PANEL_SPECS,
  parseStoredWidth,
  savePanelWidth,
  type WidthStorage,
} from "./panelWidths"

class FakeStorage implements WidthStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const throwing: WidthStorage = {
  getItem: () => {
    throw new Error("denied")
  },
  setItem: () => {
    throw new Error("quota")
  },
}

const sidebar = PANEL_SPECS.sidebar

describe("clampWidth", () => {
  it("keeps widths inside the panel's range and rounds them", () => {
    expect(clampWidth(sidebar, 100)).toBe(180)
    expect(clampWidth(sidebar, 900)).toBe(480)
    expect(clampWidth(sidebar, 300.6)).toBe(301)
  })

  it("uses the default for non-finite widths", () => {
    expect(clampWidth(sidebar, Number.NaN)).toBe(264)
    expect(clampWidth(sidebar, Number.POSITIVE_INFINITY)).toBe(264)
  })
})

describe("parseStoredWidth", () => {
  it("falls back to the default for missing or malformed values", () => {
    for (const raw of [null, "", "abc", "12px", "1e3", "NaN", "Infinity"]) {
      expect(parseStoredWidth(sidebar, raw)).toBe(264)
    }
  })

  it("clamps stored numbers that are out of range", () => {
    expect(parseStoredWidth(sidebar, "320")).toBe(320)
    expect(parseStoredWidth(sidebar, "5")).toBe(180)
    expect(parseStoredWidth(sidebar, "-40")).toBe(180)
  })
})

describe("loadPanelWidths / savePanelWidth", () => {
  it("round-trips through storage", () => {
    const storage = new FakeStorage()
    savePanelWidth("dynamoSide", 512, storage)
    expect(loadPanelWidths(storage)).toEqual({ ...defaultPanelWidths(), dynamoSide: 512 })
  })

  it("uses defaults when storage is missing or throws", () => {
    expect(loadPanelWidths(null)).toEqual(defaultPanelWidths())
    expect(loadPanelWidths(throwing)).toEqual(defaultPanelWidths())
    expect(() => savePanelWidth("sidebar", 300, throwing)).not.toThrow()
  })
})

describe("dragWidth", () => {
  it("grows an end-edge panel when dragged right and a start-edge panel when dragged left", () => {
    expect(dragWidth(sidebar, 264, 40, "end")).toBe(304)
    expect(dragWidth(PANEL_SPECS.dynamoSide, 400, -60, "start")).toBe(460)
    expect(dragWidth(PANEL_SPECS.dynamoSide, 400, 500, "start")).toBe(280)
  })
})
