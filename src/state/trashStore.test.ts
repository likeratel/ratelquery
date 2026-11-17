import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport } from "../lib/ipc"
import type { TrashEntry, TrashSummary } from "../lib/trash"
import { onTrashFocus, PURGE_INTERVAL_MS, useTrashStore } from "./trashStore"

const summary = (id: string): TrashSummary => ({
  id,
  status: "committed",
  deletedAt: "2026-01-02T03:04:05.678Z",
  connectionId: "c1",
  connectionName: "Local",
  database: "shop",
  table: "users",
  source: "grid",
  statement: null,
  columns: [{ name: "id", typeName: "INT" }],
  primaryKey: ["id"],
  rowCount: 2,
})

const entry = (id: string): TrashEntry => {
  const { rowCount: _count, ...rest } = summary(id)
  return { ...rest, rows: [[{ t: "int", v: "1" }], [{ t: "int", v: "2" }]] }
}

const TARGET = { connectionName: "Local", otherConnection: false }

let calls: { command: string; args?: Record<string, unknown> }[] = []
let list: TrashSummary[] = []
let restore: () => void = () => {}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  calls = []
  list = [summary("a"), summary("b")]
  useTrashStore.setState({
    summaries: [],
    loaded: false,
    loadError: null,
    selectedId: null,
    entry: null,
    entryError: null,
    restore: null,
    restoring: false,
  })
  restore = setTransport(async (command, args) => {
    calls.push({ command, args })
    switch (command) {
      case "trash_list":
        return list
      case "trash_get":
        if (!list.some((s) => s.id === args?.id)) throw { kind: "not_found", message: "gone" }
        return entry(String(args?.id))
      case "trash_restore_preview":
        return {
          statements: ["INSERT INTO `shop`.`users` (`id`) VALUES (1)"],
          total: 1,
          warning: null,
          nonTransactionalEngine: null,
        }
      case "trash_restore":
        list = list.filter((s) => s.id !== args?.id)
        return { restoredRows: 2, remainingRows: 0, warning: null }
      case "trash_delete":
        list = list.filter((s) => s.id !== args?.id)
        return null
      case "trash_purge":
        return 0
      case "trash_empty":
        list = []
        return 2
      default:
        throw { kind: "not_found", message: command }
    }
  })
})
afterEach(() => restore())

describe("trashStore", () => {
  it("reloads the open entry only when its summary changed", async () => {
    await useTrashStore.getState().refresh()
    await useTrashStore.getState().select("a")
    const gets = () => calls.filter((c) => c.command === "trash_get").length
    await useTrashStore.getState().refresh()
    expect(gets()).toBe(1)
    list = [{ ...summary("a"), rowCount: 1 }, summary("b")]
    await useTrashStore.getState().refresh()
    expect(gets()).toBe(2)
  })

  it("purges at most once a day on focus", async () => {
    const purges = () => calls.filter((c) => c.command === "trash_purge").length
    await onTrashFocus(Date.now())
    expect(purges()).toBe(0)
    await onTrashFocus(Date.now() + PURGE_INTERVAL_MS + 1)
    expect(purges()).toBe(1)
    await onTrashFocus(Date.now() + PURGE_INTERVAL_MS + 2)
    expect(purges()).toBe(1)
  })

  it("marks a running restore and refuses a second one meanwhile", async () => {
    let finish: (value: unknown) => void = () => {}
    restore()
    restore = setTransport(async (command) => {
      calls.push({ command })
      if (command === "trash_restore_preview") {
        return { statements: [], total: 0, warning: null, nonTransactionalEngine: null }
      }
      if (command === "trash_restore") return new Promise((resolve) => (finish = resolve))
      if (command === "trash_list") return list
      throw { kind: "not_found", message: command }
    })
    useTrashStore.getState().requestRestore("a", {}, 2, TARGET)
    await flush()
    const running = useTrashStore.getState().confirmRestore()
    expect(useTrashStore.getState().restoring).toBe(true)
    useTrashStore.getState().requestRestore("a", {}, 2, TARGET)
    await flush()
    await expect(useTrashStore.getState().confirmRestore()).resolves.toBeNull()
    finish({ restoredRows: 2, remainingRows: 0, warning: null })
    await running
    expect(useTrashStore.getState().restoring).toBe(false)
    expect(calls.filter((c) => c.command === "trash_restore")).toHaveLength(1)
  })

  it("loads the list and an entry, and closes an entry that went away", async () => {
    await useTrashStore.getState().refresh()
    expect(useTrashStore.getState().summaries.map((s) => s.id)).toEqual(["a", "b"])
    await useTrashStore.getState().select("a")
    expect(useTrashStore.getState().entry?.rows).toHaveLength(2)
    list = [summary("b")]
    await useTrashStore.getState().refresh()
    expect(useTrashStore.getState()).toMatchObject({ selectedId: null, entry: null })
  })

  it("restores only after the preview loaded and the user confirmed", async () => {
    await useTrashStore.getState().refresh()
    useTrashStore.getState().requestRestore("a", { rowIndexes: [1] }, 1, TARGET)
    await expect(useTrashStore.getState().confirmRestore()).resolves.toBeNull()
    expect(calls.some((c) => c.command === "trash_restore")).toBe(false)
    await flush()
    expect(useTrashStore.getState().restore?.preview).toMatchObject({ status: "ready" })
    const result = await useTrashStore.getState().confirmRestore()
    expect(result).toEqual({ restoredRows: 2, remainingRows: 0, warning: null })
    expect(calls.find((c) => c.command === "trash_restore")?.args).toEqual({
      id: "a",
      options: { rowIndexes: [1] },
    })
    expect(useTrashStore.getState().summaries.map((s) => s.id)).toEqual(["b"])
  })

  it("drops a cancelled restore and a late preview", async () => {
    useTrashStore.getState().requestRestore("a", {}, 2, TARGET)
    useTrashStore.getState().cancelRestore()
    await flush()
    expect(useTrashStore.getState().restore).toBeNull()
  })

  it("deletes and empties, then reloads", async () => {
    await useTrashStore.getState().refresh()
    await useTrashStore.getState().remove("a")
    expect(useTrashStore.getState().summaries.map((s) => s.id)).toEqual(["b"])
    await expect(useTrashStore.getState().empty()).resolves.toBe(2)
    expect(useTrashStore.getState().summaries).toEqual([])
  })

  it("keeps a failed restore's error for the caller and still reloads", async () => {
    restore()
    restore = setTransport(async (command) => {
      calls.push({ command })
      if (command === "trash_restore_preview") {
        return { statements: [], total: 0, warning: null, nonTransactionalEngine: null }
      }
      if (command === "trash_restore")
        throw { kind: "query", message: "row 1 could not be restored" }
      if (command === "trash_list") return list
      throw { kind: "not_found", message: command }
    })
    useTrashStore.getState().requestRestore("a", {}, 2, TARGET)
    await flush()
    await expect(useTrashStore.getState().confirmRestore()).rejects.toMatchObject({ kind: "query" })
    expect(calls.filter((c) => c.command === "trash_list")).toHaveLength(1)
  })
})
