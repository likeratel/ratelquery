import { describe, expect, it } from "vitest"
import { DEFAULT_ZOOM, formatZoom, nearestZoomLevel, stepZoom, ZOOM_LEVELS } from "./zoom"

describe("stepZoom", () => {
  it("moves one level at a time", () => {
    expect(stepZoom(100, "in")).toBe(110)
    expect(stepZoom(110, "in")).toBe(125)
    expect(stepZoom(100, "out")).toBe(90)
    expect(stepZoom(150, "out")).toBe(125)
  })

  it("stays at the ends", () => {
    expect(stepZoom(ZOOM_LEVELS.at(-1)!, "in")).toBe(175)
    expect(stepZoom(ZOOM_LEVELS[0], "out")).toBe(80)
  })

  it("steps from a value between levels to the nearest level in that direction", () => {
    expect(stepZoom(130, "in")).toBe(150)
    expect(stepZoom(130, "out")).toBe(125)
  })

  it("resets to the default from anywhere", () => {
    expect(stepZoom(175, "reset")).toBe(DEFAULT_ZOOM)
    expect(stepZoom(80, "reset")).toBe(100)
  })
})

describe("nearestZoomLevel", () => {
  it("keeps a level as it is", () => {
    for (const level of ZOOM_LEVELS) expect(nearestZoomLevel(level)).toBe(level)
  })

  it("snaps a value between levels to the closer one, the lower on a tie", () => {
    expect(nearestZoomLevel(130)).toBe(125)
    expect(nearestZoomLevel(140)).toBe(150)
    expect(nearestZoomLevel(105)).toBe(100)
    expect(nearestZoomLevel(85)).toBe(80)
  })

  it("snaps a value past either end to that end", () => {
    expect(nearestZoomLevel(50)).toBe(80)
    expect(nearestZoomLevel(400)).toBe(175)
  })
})

describe("formatZoom", () => {
  it("shows a percentage", () => {
    expect(formatZoom(125)).toBe("125%")
  })
})
