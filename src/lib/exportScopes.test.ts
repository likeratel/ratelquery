import { describe, expect, it } from "vitest"
import { itemExportScopes, rowExportScopes } from "./exportScopes"

describe("rowExportScopes", () => {
  it("offers the full result for single statement runs", () => {
    const [visible, full] = rowExportScopes(1234, true)
    expect(visible).toMatchObject({ id: "visible", hint: `${(1234).toLocaleString()} loaded` })
    expect(full).toMatchObject({ id: "full", disabled: false, title: undefined })
  })

  it("explains why the full result is off for multi-statement runs", () => {
    const [, full] = rowExportScopes(3, false)
    expect(full).toMatchObject({ disabled: true, hint: "Single statement only" })
    expect(full.title).toMatch(/single statement/)
  })
})

describe("itemExportScopes", () => {
  it("names the request kind", () => {
    expect(itemExportScopes({ scan: { table: "t" } })[0].hint).toMatch(/^Scans/)
    expect(itemExportScopes({ query: { table: "t", hash: { S: "a" } } })[0].hint).toMatch(
      /^Queries/,
    )
  })
})
