import { describe, expect, it } from "vitest"
import {
  clampWidth,
  defaultPanelWidths,
  dragWidth,
  loadPanelWidths,
  panelCap,
  panelColumn,
  PANEL_SPECS,
  parseStoredWidth,
  savePanelWidth,
  shownWidth,
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

  it("starts a capped panel from the width shown, so its edge follows the pointer", () => {
    // A 900px window at 35% shows a 400px sidebar at 315px.
    expect(dragWidth(sidebar, 400, -40, "end", 900)).toBe(275)
    // An 800px items area at 45% shows a 400px item panel at 360px.
    expect(dragWidth(PANEL_SPECS.dynamoSide, 400, 20, "start", 800)).toBe(340)
  })

  it("never stores more than the cap shows", () => {
    expect(dragWidth(sidebar, 400, 60, "end", 900)).toBe(315)
    expect(dragWidth(sidebar, 264, 200, "end", 900)).toBe(315)
    expect(dragWidth(PANEL_SPECS.dynamoSide, 300, -100, "start", 800)).toBe(360)
  })
})

describe("panel caps", () => {
  it("caps the column at the panel's share of its container in CSS", () => {
    expect(panelColumn(sidebar, 264)).toBe("min(264px, 35%)")
    expect(panelColumn(PANEL_SPECS.dynamoSide, 400)).toBe("min(400px, 45%)")
  })

  it("computes the width shown, even below the panel's minimum", () => {
    expect(panelCap(sidebar, 900)).toBe(315)
    expect(panelCap(sidebar, 300)).toBe(105)
    expect(panelCap(sidebar, Infinity)).toBe(Infinity)
    expect(shownWidth(sidebar, 400, 900)).toBe(315)
    expect(shownWidth(sidebar, 264, 900)).toBe(264)
    expect(shownWidth(sidebar, 264, Infinity)).toBe(264)
  })
})
