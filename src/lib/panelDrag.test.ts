import { describe, expect, it } from "vitest"
import { DRAG_ATTRIBUTE, startPanelDrag, type DragMarker } from "./panelDrag"

function fakeMarker(): DragMarker & { attributes: Set<string> } {
  const attributes = new Set<string>()
  return {
    attributes,
    setAttribute: (name) => void attributes.add(name),
    removeAttribute: (name) => void attributes.delete(name),
  }
}

function pointer(type: string, clientX = 0): Event {
  return Object.assign(new Event(type), { clientX })
}

function drag() {
  const target = new EventTarget()
  const marker = fakeMarker()
  const moves: number[] = []
  let ends = 0
  const end = startPanelDrag({
    target,
    marker,
    startX: 100,
    onMove: (delta) => moves.push(delta),
    onEnd: () => (ends += 1),
  })
  return { target, marker, moves, end, ends: () => ends }
}

describe("startPanelDrag", () => {
  it("reports moves until the pointer is released, then cleans up once", () => {
    const d = drag()
    expect(d.marker.attributes.has(DRAG_ATTRIBUTE)).toBe(true)
    d.target.dispatchEvent(pointer("pointermove", 130))
    d.target.dispatchEvent(pointer("pointerup"))
    d.target.dispatchEvent(pointer("pointermove", 160))
    d.end()
    expect(d.moves).toEqual([30])
    expect(d.ends()).toBe(1)
    expect(d.marker.attributes.has(DRAG_ATTRIBUTE)).toBe(false)
  })

  it("cleans up when ended before release, as when the handle unmounts mid-drag", () => {
    const d = drag()
    d.target.dispatchEvent(pointer("pointermove", 90))
    d.end()
    d.target.dispatchEvent(pointer("pointermove", 50))
    d.target.dispatchEvent(pointer("pointercancel"))
    expect(d.moves).toEqual([-10])
    expect(d.ends()).toBe(1)
    expect(d.marker.attributes.has(DRAG_ATTRIBUTE)).toBe(false)
  })
})
