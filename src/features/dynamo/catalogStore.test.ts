import { afterEach, describe, expect, it } from "vitest"
import type { TableDescription } from "../../lib/dynamo"
import { setTransport } from "../../lib/ipc"
import { useDynamoCatalog } from "./catalogStore"

const description: TableDescription = {
  name: "users",
  status: "ACTIVE",
  keySchema: { hash: { name: "pk", type: "S" }, range: null },
  indexes: [],
  itemCount: 0,
  sizeBytes: 0,
  billingMode: null,
}

/** Backend whose answers wait until the test releases them. */
function slowBackend() {
  const waiting: (() => void)[] = []
  const restore = setTransport(
    (command) =>
      new Promise((resolve) => {
        waiting.push(() => resolve(command === "dynamo_list_tables" ? ["users"] : description))
      }),
  )
  const releaseAll = async () => {
    for (const answer of waiting.splice(0)) answer()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { restore, releaseAll }
}

let restore: () => void = () => {}
afterEach(() => {
  restore()
  useDynamoCatalog.setState({ catalogs: {} })
})

describe("forget", () => {
  it("ignores table lists and descriptions that arrive after the connection is deleted", async () => {
    const backend = slowBackend()
    restore = backend.restore
    const store = useDynamoCatalog.getState()
    const listing = store.loadTables("gone")
    const describing = store.describe("gone", "users")
    store.forget("gone")
    await backend.releaseAll()
    await Promise.all([listing, describing])
    expect(useDynamoCatalog.getState().catalogs.gone).toBeUndefined()
  })

  it("loads the catalog again once tables are listed anew", async () => {
    const backend = slowBackend()
    restore = backend.restore
    const store = useDynamoCatalog.getState()
    const stale = store.loadTables("again")
    store.forget("again")
    const fresh = store.loadTables("again")
    expect(fresh).not.toBe(stale)
    await backend.releaseAll()
    await Promise.all([stale, fresh])
    expect(useDynamoCatalog.getState().catalogs.again).toMatchObject({
      tables: ["users"],
      loading: false,
    })
  })
})
