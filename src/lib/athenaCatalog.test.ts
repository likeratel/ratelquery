import { describe, expect, it } from "vitest"
import {
  emptyAthenaCatalog,
  failDatabases,
  failSchema,
  finishDatabases,
  finishSchema,
  isAthenaSchemaLoading,
  setCurrentDatabase,
  startDatabases,
  startSchema,
} from "./athenaCatalog"
import type { SchemaSnapshot } from "./mysql"

const snapshot = (database: string): SchemaSnapshot => ({
  database,
  fetchedAt: "2026-01-01T00:00:00Z",
  tables: [{ name: "events", kind: "table", columns: [] }],
})

const error = { kind: "credential", message: "expired" } as const

describe("database list", () => {
  it("tracks loading and stores a copy of the list", () => {
    const names = ["analytics", "raw"]
    const loading = startDatabases(emptyAthenaCatalog())
    expect(loading.loading).toBe(true)
    const done = finishDatabases(loading, names)
    expect(done).toMatchObject({ loading: false, databases: ["analytics", "raw"] })
    expect(done.databases).not.toBe(names)
  })

  it("keeps the previous list next to a failure and clears the error on the next start", () => {
    const listed = finishDatabases(emptyAthenaCatalog(), ["a"])
    const failed = failDatabases(startDatabases(listed), error)
    expect(failed).toMatchObject({ loading: false, databases: ["a"], lastError: error })
    expect(startDatabases(failed).lastError).toBeNull()
  })
})

describe("schemas", () => {
  it("stores the snapshot under the requested name and clears its loading flag", () => {
    const loading = startSchema(emptyAthenaCatalog(), "Sales")
    expect(isAthenaSchemaLoading(loading, "Sales")).toBe(true)
    const done = finishSchema(loading, "Sales", snapshot("sales"))
    expect(isAthenaSchemaLoading(done, "Sales")).toBe(false)
    expect(done.schemas.Sales?.tables[0]?.name).toBe("events")
  })

  it("keeps a cached snapshot when a refresh fails", () => {
    const cached = finishSchema(emptyAthenaCatalog(), "sales", snapshot("sales"))
    const failed = failSchema(startSchema(cached, "sales"), "sales", error)
    expect(failed.schemas.sales).toBe(cached.schemas.sales)
    expect(failed.schemaLoading).toEqual({})
    expect(failed.lastError).toBe(error)
  })

  it("does not change the input catalog", () => {
    const before = emptyAthenaCatalog()
    startSchema(before, "x")
    startDatabases(before)
    expect(before).toEqual(emptyAthenaCatalog())
  })
})

describe("setCurrentDatabase", () => {
  it("returns the same object when nothing changes", () => {
    const catalog = emptyAthenaCatalog("sales")
    expect(setCurrentDatabase(catalog, "sales")).toBe(catalog)
    expect(setCurrentDatabase(catalog, null).currentDatabase).toBeNull()
  })

  it("reports no loading for a null database or a missing catalog", () => {
    expect(isAthenaSchemaLoading(undefined, "x")).toBe(false)
    expect(isAthenaSchemaLoading(emptyAthenaCatalog(), null)).toBe(false)
  })
})
