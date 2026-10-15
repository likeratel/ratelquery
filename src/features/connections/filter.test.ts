import { describe, expect, it } from "vitest"
import type { ConnectionConfig } from "../../lib/connections"
import { connectionSubtitle, filterConnections, upsertConnection } from "./filter"

const mysql: ConnectionConfig = {
  kind: "mysql",
  id: "1",
  name: "Billing",
  host: "db.internal",
  port: 3306,
  user: "app",
}
const dynamo: ConnectionConfig = {
  kind: "dynamodb",
  id: "2",
  name: "Events",
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  auth: { type: "profile", profile: "default" },
}

describe("connectionSubtitle", () => {
  it("shows host and port or region and endpoint", () => {
    expect(connectionSubtitle(mysql)).toBe("db.internal:3306")
    expect(connectionSubtitle(dynamo)).toBe("us-east-1 · http://localhost:8000")
  })
})

describe("filterConnections", () => {
  it("matches name and subtitle case-insensitively", () => {
    expect(filterConnections([mysql, dynamo], "  EVE ")).toEqual([dynamo])
    expect(filterConnections([mysql, dynamo], "internal")).toEqual([mysql])
    expect(filterConnections([mysql, dynamo], "")).toEqual([mysql, dynamo])
  })
})

describe("upsertConnection", () => {
  it("replaces by id without mutating and keeps name order", () => {
    const list = [dynamo, mysql]
    const renamed = { ...mysql, name: "Zeta" }
    const next = upsertConnection(list, renamed)
    expect(next.map((c) => c.name)).toEqual(["Events", "Zeta"])
    expect(list[1]).toBe(mysql)
  })

  it("appends new entries in sorted position", () => {
    const next = upsertConnection([dynamo], mysql)
    expect(next.map((c) => c.id)).toEqual(["1", "2"])
  })
})
