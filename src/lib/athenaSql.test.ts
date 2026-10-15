import { describe, expect, it } from "vitest"
import { athenaSelectRowsSql, quoteAthenaIdentifier } from "./athenaSql"

describe("quoteAthenaIdentifier", () => {
  it("wraps the name in double quotes and doubles quotes inside it", () => {
    expect(quoteAthenaIdentifier("events")).toBe('"events"')
    expect(quoteAthenaIdentifier('we"ird')).toBe('"we""ird"')
  })
})

describe("athenaSelectRowsSql", () => {
  it("names the database and table explicitly", () => {
    expect(athenaSelectRowsSql("analytics", "page views", 100)).toBe(
      'SELECT * FROM "analytics"."page views" LIMIT 100',
    )
  })
})
