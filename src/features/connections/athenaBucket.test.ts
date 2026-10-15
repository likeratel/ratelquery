import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AthenaConnectionConfig, AthenaTestInfo } from "../../lib/connections"
import { onAppEvent } from "../../lib/events"
import { setTransport } from "../../lib/ipc"
import { useConnectionsStore } from "../../state/connectionsStore"

const config: AthenaConnectionConfig = {
  kind: "athena",
  id: "a1",
  name: "Lake",
  region: "eu-west-1",
  auth: { type: "profile", profile: "default" },
}

const BUCKET = "aws-athena-query-results-123456789012-eu-west-1"

let calls: { command: string; args?: Record<string, unknown> }[] = []
let bucketExists = false
let restore: () => void = () => {}

beforeEach(() => {
  calls = []
  bucketExists = false
  restore = setTransport(async (command, args) => {
    calls = [...calls, { command, args }]
    if (command === "connections_test") {
      const athena: AthenaTestInfo = bucketExists
        ? { workgroup: "primary", outputLocation: `s3://${BUCKET}/`, missingBucket: null }
        : { workgroup: "primary", outputLocation: null, missingBucket: BUCKET }
      return { ok: true, latencyMs: 40, athena }
    }
    if (command === "athena_create_output_bucket") {
      bucketExists = true
      return { outputLocation: `s3://${BUCKET}/` }
    }
    if (command === "connections_has_secret") return false
    if (command === "connections_save") return args?.config
    throw { kind: "unknown", message: command }
  })
  useConnectionsStore.getState().openDialog()
})
afterEach(() => {
  restore()
  useConnectionsStore.getState().closeDialog()
  useConnectionsStore.setState({ connections: [] })
})

describe("Athena output bucket", () => {
  it("reports a missing default bucket from the test without creating it", async () => {
    await useConnectionsStore.getState().testConnection(config, null)
    expect(useConnectionsStore.getState().test).toEqual({
      status: "ok",
      latencyMs: 40,
      serverVersion: undefined,
      athena: { workgroup: "primary", outputLocation: null, missingBucket: BUCKET },
    })
    expect(calls.map((c) => c.command)).toEqual(["connections_test"])
  })

  it("creates the bucket only when asked, then tests again", async () => {
    await useConnectionsStore.getState().testConnection(config, null)
    const error = await useConnectionsStore.getState().createOutputBucket(config, null, BUCKET)
    expect(error).toBeNull()
    expect(calls.map((c) => c.command)).toEqual([
      "connections_test",
      "athena_create_output_bucket",
      "connections_test",
    ])
    expect(calls[1].args).toEqual({ config, secret: null, bucket: BUCKET })
    const test = useConnectionsStore.getState().test
    expect(test.status === "ok" && test.athena?.missingBucket).toBeNull()
  })

  it("returns a friendly error when the bucket can't be created", async () => {
    restore()
    restore = setTransport(async (command) => {
      if (command === "athena_create_output_bucket") {
        throw { kind: "credential", message: "AccessDenied" }
      }
      throw { kind: "unknown", message: command }
    })
    const error = await useConnectionsStore.getState().createOutputBucket(config, null, BUCKET)
    expect(error?.summary).toContain("Couldn't create the bucket.")
    expect(error?.detail).toBe("AccessDenied")
  })
})

describe("connection-updated", () => {
  it("fires when an existing connection is saved again, not for a new one", async () => {
    const updated: string[] = []
    const off = onAppEvent("connection-updated", (id) => updated.push(id))
    await useConnectionsStore.getState().save(config, null)
    expect(updated).toEqual([])
    await useConnectionsStore.getState().save({ ...config, workgroup: "etl" }, null)
    expect(updated).toEqual(["a1"])
    off()
  })
})
