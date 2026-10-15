import { describe, expect, it } from "vitest"
import { quoteIdentifier, selectRowsLimit, selectRowsSql } from "./sql"

describe("selectRowsSql", () => {
  it("selects with the default limit", () => {
    expect(selectRowsLimit()).toBe(1000)
    expect(selectRowsSql("users")).toBe("SELECT * FROM `users` LIMIT 1000")
  })

  it("doubles backticks inside the name", () => {
    expect(quoteIdentifier("we`ird")).toBe("`we``ird`")
    expect(selectRowsSql("a`b`", 5)).toBe("SELECT * FROM `a``b``` LIMIT 5")
  })

  it("keeps other characters as they are", () => {
    expect(selectRowsSql("order items; drop")).toBe("SELECT * FROM `order items; drop` LIMIT 1000")
  })
})
