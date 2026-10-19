import { describe, expect, it } from "vitest"
import { placeMenu } from "./menuPosition"

const viewport = { width: 800, height: 600 }
const menu = { width: 200, height: 150 }

describe("placeMenu", () => {
  it("opens at the point when the menu fits", () => {
    expect(placeMenu({ x: 100, y: 120 }, menu, viewport)).toEqual({ x: 100, y: 120 })
  })

  it("flips to the left of and above the point near the far edges", () => {
    expect(placeMenu({ x: 700, y: 500 }, menu, viewport)).toEqual({ x: 500, y: 350 })
  })

  it("clamps to the margin when neither side fits", () => {
    expect(placeMenu({ x: 150, y: 100 }, { width: 900, height: 700 }, viewport)).toEqual({
      x: 4,
      y: 4,
    })
  })
})
