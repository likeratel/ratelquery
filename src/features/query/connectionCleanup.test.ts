import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport } from "../../lib/ipc"
import { INITIAL_TABS } from "../../lib/queryTabs"
import { useConnectionsStore } from "../../state/connectionsStore"
import { emptySession, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { emptyCatalog, useDynamoCatalog } from "../dynamo/catalogStore"
import { subscribeConnectionCleanup } from "./actions"

let restore: () => void = () => {}
let unsubscribe: () => void = () => {}

beforeEach(() => {
  useTabsStore.setState({ ...INITIAL_TABS })
  useSessionsStore.setState({ sessions: { m1: emptySession(), m2: emptySession() } })
  useDynamoCatalog.setState({ catalogs: { d1: emptyCatalog(), d2: emptyCatalog() } })
  useConnectionsStore.setState({
    connections: [
      { kind: "mysql", id: "m1", name: "A", host: "h", port: 3306, user: "u" },
      {
        kind: "dynamodb",
        id: "d1",
        name: "B",
        region: "us-east-1",
        auth: { type: "profile", profile: "p" },
      },
    ],
  })
  unsubscribe = subscribeConnectionCleanup()
})

afterEach(() => {
  unsubscribe()
  restore()
})

describe("deleting a connection", () => {
  it("closes its tabs and drops its session and catalog", async () => {
    let fail = false
    restore = setTransport(async (command) => {
      if (command === "connections_delete" && fail) throw { kind: "io", message: "disk full" }
      return undefined
    })
    const tabs = useTabsStore.getState()
    tabs.open("m1", "app")
    tabs.open("m1", null)
    const keep = tabs.open("m2", null)
    tabs.openDynamo("d1")
    const keepDynamo = tabs.openDynamo("d2")

    await useConnectionsStore.getState().remove("m1")
    await useConnectionsStore.getState().remove("d1")
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual([keep, keepDynamo])
    expect(Object.keys(useSessionsStore.getState().sessions)).toEqual(["m2"])
    expect(Object.keys(useDynamoCatalog.getState().catalogs)).toEqual(["d2"])

    fail = true
    await expect(useConnectionsStore.getState().remove("m2")).resolves.toMatchObject({ ok: false })
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual([keep, keepDynamo])
  })
})
