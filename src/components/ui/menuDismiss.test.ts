import { describe, expect, it } from "vitest"
import { closesMenu } from "./menuDismiss"

/** A container holding exactly the given nodes. */
const holding = (...nodes: object[]) => ({
  contains: (node: Node | null) => nodes.includes(node as object),
})

describe("closesMenu", () => {
  const inside = {}
  const onTrigger = {}
  const elsewhere = {}
  const menu = holding(inside)
  const trigger = holding(onTrigger)

  it("closes on presses outside the menu and its trigger", () => {
    expect(closesMenu(elsewhere as EventTarget, menu, trigger)).toBe(true)
    expect(closesMenu(null, menu, trigger)).toBe(true)
  })

  it("stays open for presses inside the menu", () => {
    expect(closesMenu(inside as EventTarget, menu, trigger)).toBe(false)
  })

  it("leaves presses on the trigger to its click toggle", () => {
    expect(closesMenu(onTrigger as EventTarget, menu, trigger)).toBe(false)
    // Without a trigger the same press is outside and closes the menu.
    expect(closesMenu(onTrigger as EventTarget, menu)).toBe(true)
  })
})
