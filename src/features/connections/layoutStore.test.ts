import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useToastStore } from "../../components/ui/toastStore"
import {
  moveToFolder,
  placeAfter,
  type ConnectionLayout,
  type LayoutItem,
} from "../../lib/connectionLayout"
import type { ConnectionConfig } from "../../lib/connections"
import { setTransport, type AppError } from "../../lib/ipc"
import { useConnectionLayout } from "../../state/connectionLayoutStore"
import { useConnectionsStore } from "../../state/connectionsStore"

const conn = (id: string, name = id): ConnectionConfig => ({
  kind: "mysql",
  id,
  name,
  host: "localhost",
  port: 3306,
  user: "root",
})

const saved: ConnectionLayout = {
  version: 2,
  folders: [{ id: "F", name: "Prod", collapsed: true }],
  items: [
    { type: "folder", id: "F", children: [{ type: "connection", id: "b" }] },
    { type: "connection", id: "a" },
  ],
}

const toF = (id: string) => (layout: ConnectionLayout) =>
  moveToFolder(layout, { type: "connection", id }, "F")

let file: unknown = null
let saveError: AppError | null = null
let saves: unknown[] = []
let restore: () => void
const initialLayout = useConnectionLayout.getState()
const initialConnections = useConnectionsStore.getState()

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  file = saved
  saveError = null
  saves = []
  restore = setTransport(async (command, args) => {
    if (command === "connection_layout_load") return file
    if (command === "connection_layout_save") {
      if (saveError) throw saveError
      saves = [...saves, args?.layout]
      return undefined
    }
    throw { kind: "unknown", message: `unexpected ${command}` }
  })
  useConnectionLayout.setState(initialLayout, true)
  useConnectionsStore.setState(
    { ...initialConnections, connections: [conn("a"), conn("b"), conn("c")], status: "ready" },
    true,
  )
  useToastStore.setState({ toasts: [] })
})

afterEach(() => restore())

type Ids = (string | Ids)[]
const itemIds = (items: readonly LayoutItem[]): Ids =>
  items.map((item) => (item.type === "folder" ? [item.id, ...itemIds(item.children)] : item.id))
const ids = (layout: ConnectionLayout) => itemIds(layout.items)

describe("connection layout store", () => {
  it("loads the saved layout and treats an invalid file as empty", async () => {
    await useConnectionLayout.getState().load()
    expect(useConnectionLayout.getState()).toMatchObject({ status: "ready", layout: saved })
    file = { ...saved, version: 1, items: [{ type: "folder", id: "F", children: ["b"] }] }
    await useConnectionLayout.getState().load()
    expect(ids(useConnectionLayout.getState().layout)).toEqual([["F", "b"]])
    file = { version: 7 }
    await useConnectionLayout.getState().load()
    expect(useConnectionLayout.getState().layout.items).toEqual([])
  })

  it("applies changes to the reconciled layout and saves them", async () => {
    await useConnectionLayout.getState().load()
    useConnectionLayout.getState().update(toF("c"))
    await flush()
    const layout = useConnectionLayout.getState().layout
    expect(ids(layout)).toEqual([["F", "b", "c"], "a"])
    expect(saves).toEqual([layout])
  })

  it("saves a version 1 file back as version 2", async () => {
    file = {
      version: 1,
      folders: [{ id: "F", name: "Prod", collapsed: false }],
      items: [
        { type: "folder", id: "F", children: ["b"] },
        { type: "connection", id: "a" },
      ],
    }
    await useConnectionLayout.getState().load()
    useConnectionLayout.getState().update(toF("a"))
    await flush()
    expect(saves).toEqual([
      {
        version: 2,
        folders: [{ id: "F", name: "Prod", collapsed: false }],
        items: [
          {
            type: "folder",
            id: "F",
            children: [
              { type: "connection", id: "b" },
              { type: "connection", id: "a" },
            ],
          },
          { type: "connection", id: "c" },
        ],
      },
    ])
  })

  it("places a duplicate right after its source", async () => {
    await useConnectionLayout.getState().load()
    useConnectionsStore.setState({ connections: [conn("a"), conn("b"), conn("b2"), conn("c")] })
    useConnectionLayout.getState().update((layout) => placeAfter(layout, "b2", "b"))
    expect(ids(useConnectionLayout.getState().layout)).toEqual([["F", "b", "b2"], "a", "c"])
  })

  it("creates a folder and starts renaming it", async () => {
    await useConnectionLayout.getState().load()
    const id = useConnectionLayout.getState().createFolder()
    const state = useConnectionLayout.getState()
    expect(state.renaming).toBe(id)
    expect(state.layout.folders.at(-1)).toEqual({ id, name: "New folder", collapsed: false })
  })

  it("creates a subfolder inside a folder", async () => {
    await useConnectionLayout.getState().load()
    const id = useConnectionLayout.getState().createFolder("F")
    const state = useConnectionLayout.getState()
    expect(state.renaming).toBe(id)
    expect(ids(state.layout)[0]).toEqual(["F", "b", [id]])
    expect(state.layout.folders[0]).toMatchObject({ id: "F", collapsed: false })
    await flush()
    expect(saves).toEqual([state.layout])
  })

  it("keeps the change and warns once when saving fails", async () => {
    await useConnectionLayout.getState().load()
    saveError = { kind: "io", message: "disk full" }
    const { update } = useConnectionLayout.getState()
    update(toF("a"))
    update(toF("c"))
    await flush()
    expect(ids(useConnectionLayout.getState().layout)).toEqual([["F", "b", "a", "c"]])
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ tone: "warning", detail: "disk full" })
  })

  it("ignores changes until the saved layout has loaded", () => {
    useConnectionLayout.setState({ status: "loading" })
    useConnectionLayout.getState().update(toF("a"))
    expect(useConnectionLayout.getState().layout.items).toEqual([])
    expect(saves).toEqual([])
  })

  it("keeps saved placements while the connection list is not loaded", async () => {
    await useConnectionLayout.getState().load()
    useConnectionsStore.setState({ connections: [], status: "loading" })
    useConnectionLayout.getState().createFolder()
    expect(ids(useConnectionLayout.getState().layout).slice(0, 2)).toEqual([["F", "b"], "a"])
  })
})
