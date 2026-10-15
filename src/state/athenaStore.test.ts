import { afterEach, describe, expect, it } from "vitest"
import { setTransport } from "../lib/ipc"
import type { SchemaSnapshot } from "../lib/mysql"
import { createAthenaSchemaRequests } from "../features/query/completion/athenaEnv"
import { useAthenaStore } from "./athenaStore"

const snapshot: SchemaSnapshot = {
  database: "sales",
  fetchedAt: "2026-01-01T00:00:00Z",
  tables: [{ name: "orders", kind: "table", columns: [] }],
}

/** Backend whose answers wait until the test releases them. */
function slowBackend(fail = false) {
  const calls: string[] = []
  const waiting: (() => void)[] = []
  const restore = setTransport(
    (command) =>
      new Promise((resolve, reject) => {
        calls.push(command)
        waiting.push(() => {
          if (fail) reject({ kind: "credential", message: "expired" })
          else resolve(command === "athena_databases" ? ["sales", "raw"] : snapshot)
        })
      }),
  )
  const releaseAll = async () => {
    for (const answer of waiting.splice(0)) answer()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { calls, restore, releaseAll }
}

let restore: () => void = () => {}
afterEach(() => {
  restore()
  useAthenaStore.setState({ catalogs: {} })
})

describe("athenaStore", () => {
  it("shares one database listing between concurrent callers and caches it", async () => {
    const backend = slowBackend()
    restore = backend.restore
    const store = useAthenaStore.getState()
    const first = store.loadDatabases("a1")
    const second = store.loadDatabases("a1")
    expect(useAthenaStore.getState().catalogs.a1?.loading).toBe(true)
    await backend.releaseAll()
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
    expect(backend.calls).toEqual(["athena_databases"])
    expect(useAthenaStore.getState().catalogs.a1?.databases).toEqual(["sales", "raw"])
    await store.loadDatabases("a1")
    expect(backend.calls).toHaveLength(1)
  })

  it("resolves with the error and keeps it in lastError", async () => {
    const backend = slowBackend(true)
    restore = backend.restore
    const request = useAthenaStore.getState().loadDatabases("a1")
    await backend.releaseAll()
    await expect(request).resolves.toEqual({ kind: "credential", message: "expired" })
    expect(useAthenaStore.getState().catalogs.a1).toMatchObject({
      loading: false,
      databases: null,
      lastError: { kind: "credential" },
    })
  })

  it("fetches a schema once and keeps it under the requested name", async () => {
    const backend = slowBackend()
    restore = backend.restore
    const store = useAthenaStore.getState()
    const loading = store.setCurrentDatabase("a1", "Sales")
    await backend.releaseAll()
    await loading
    const catalog = useAthenaStore.getState().catalogs.a1
    expect(catalog?.currentDatabase).toBe("Sales")
    expect(catalog?.schemas.Sales?.tables[0]?.name).toBe("orders")
    await store.ensureSchema("a1", "Sales")
    expect(backend.calls).toEqual(["athena_schema"])
  })

  it("ignores answers that arrive after the connection was forgotten", async () => {
    const backend = slowBackend()
    restore = backend.restore
    const store = useAthenaStore.getState()
    const listing = store.loadDatabases("gone")
    const schema = store.refreshSchema("gone", "sales")
    store.forget("gone")
    await backend.releaseAll()
    await Promise.all([listing, schema])
    expect(useAthenaStore.getState().catalogs.gone).toBeUndefined()
    // A later request starts over.
    const again = store.loadDatabases("gone")
    await backend.releaseAll()
    await again
    expect(useAthenaStore.getState().catalogs.gone?.databases).toEqual(["sales", "raw"])
  })
})

describe("Athena completion schema requests", () => {
  it("skips unknown databases and backs off after a failure", async () => {
    const backend = slowBackend(true)
    restore = backend.restore
    let now = 0
    const request = createAthenaSchemaRequests(useAthenaStore, () => now)
    useAthenaStore.setState({
      catalogs: {
        a1: {
          databases: ["sales"],
          schemas: {},
          currentDatabase: null,
          loading: false,
          schemaLoading: {},
          lastError: null,
        },
      },
    })
    expect(request("a1", "nope")).toBeNull()
    const first = request("a1", "sales")
    expect(request("a1", "sales")).toBe(first)
    await backend.releaseAll()
    await first
    expect(request("a1", "sales")).toBeNull()
    now = 60_000
    expect(request("a1", "sales")).not.toBeNull()
    await backend.releaseAll()
    expect(backend.calls).toEqual(["athena_schema", "athena_schema"])
  })
})
