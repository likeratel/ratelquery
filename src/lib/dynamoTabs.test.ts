import { describe, expect, it } from "vitest"
import type { Item, Page } from "./dynamo"
import {
  canGoNext,
  canGoPrevious,
  createDynamoTab,
  editorIdentity,
  failDynamoRun,
  finishDynamoRun,
  isDynamoTabDirty,
  nextStartKeys,
  openEditor,
  pageNumber,
  selectedItem,
  selectItem,
  selectTable,
  setForm,
  startDynamoRun,
  updateEditor,
  type DynamoTab,
  type PageMove,
} from "./dynamoTabs"
import { activateTab, closeTab, INITIAL_TABS, openDynamoTab, openTab } from "./queryTabs"

const request = { scan: { table: "t", limit: 2 } }
const key = (n: number): Item => ({ pk: { S: `k${n}` } })
const page = (n: number, last: boolean): Page => ({
  items: [key(n * 2), key(n * 2 + 1)],
  lastKey: last ? null : key(n * 2 + 1),
  count: 2,
  scannedCount: 2,
  elapsedMs: 10 + n,
})

/** Applies a page move the way the action does: compute the stack, then store the page. */
function move(tab: DynamoTab, to: PageMove): DynamoTab {
  const keys = nextStartKeys(tab, to)
  if (!keys) throw new Error(`cannot move ${to}`)
  const index = keys.length - 1
  return finishDynamoRun(startDynamoRun(tab), request, keys, page(index, index === 2))
}

const fresh = () => selectTable(createDynamoTab("d", "conn", "DynamoDB 1"), "t")

describe("page stack", () => {
  it("pushes start keys going forward and pops them going back", () => {
    const first = move(fresh(), "first")
    expect(first.startKeys).toEqual([null])
    expect(pageNumber(first)).toBe(1)
    expect(canGoPrevious(first)).toBe(false)
    expect(canGoNext(first)).toBe(true)

    const second = move(first, "next")
    expect(second.startKeys).toEqual([null, key(1)])
    const third = move(second, "next")
    expect(pageNumber(third)).toBe(3)
    expect(canGoNext(third)).toBe(false)
    expect(nextStartKeys(third, "next")).toBeNull()

    const back = move(third, "previous")
    expect(back.startKeys).toEqual([null, key(1)])
    expect(back.page?.items).toEqual(page(1, false).items)
    expect(move(back, "current").startKeys).toEqual(back.startKeys)
    expect(nextStartKeys(move(back, "previous"), "previous")).toBeNull()
  })

  it("restarts from the first page on a new run", () => {
    const deep = move(move(fresh(), "first"), "next")
    expect(move(deep, "first").startKeys).toEqual([null])
  })

  it("refuses paging before any run", () => {
    expect(nextStartKeys(fresh(), "current")).toBeNull()
    expect(nextStartKeys(fresh(), "next")).toBeNull()
  })

  it("keeps the page and stack when a request fails", () => {
    const second = move(move(fresh(), "first"), "next")
    const failed = failDynamoRun(startDynamoRun(second), { kind: "query", message: "boom" })
    expect(failed).toMatchObject({ running: false, startKeys: second.startKeys, page: second.page })
    expect(failed.runId).toBe(second.runId + 1)
  })
})

describe("tab state", () => {
  it("resets results, form and editor when the table changes", () => {
    const ran = setForm(move(fresh(), "first"), { hash: "x", limit: "25" })
    const other = selectTable(ran, "other")
    expect(other).toMatchObject({ table: "other", title: "other", page: null, startKeys: [] })
    expect(other.form).toMatchObject({ hash: "", limit: "25" })
    expect(selectTable(ran, "t")).toBe(ran)
  })

  it("clamps selection to the page", () => {
    const ran = move(fresh(), "first")
    expect(selectItem(ran, 1).selected).toBe(1)
    expect(selectedItem(selectItem(ran, 1))).toEqual(key(1))
    expect(selectItem(ran, 5).selected).toBeNull()
  })

  it("marks the tab dirty only after editing", () => {
    const opened = openEditor(move(fresh(), "first"), key(0), "plain")
    expect(opened.editor?.text).toBe('{\n  "pk": "k0"\n}')
    expect(isDynamoTabDirty(opened)).toBe(false)
    expect(isDynamoTabDirty(updateEditor(opened, { text: "{}" }))).toBe(true)
  })
})

describe("mixed tab list", () => {
  it("numbers and closes query and dynamo tabs together", () => {
    const state = openDynamoTab(
      openTab(INITIAL_TABS, { id: "q", connectionId: "m", database: null }),
      {
        id: "d",
        connectionId: "dyn",
      },
    )
    expect(state.tabs.map((t) => [t.kind, t.title])).toEqual([
      ["query", "Query 1"],
      ["dynamo", "DynamoDB 2"],
    ])
    expect(closeTab(activateTab(state, "d"), "d").activeId).toBe("q")
  })
})

describe("editorIdentity", () => {
  const schema = { hash: { name: "pk", type: "S" as const }, range: null }
  const editorOn = (item: Item | null) => {
    const editor = openEditor(fresh(), item, "plain").editor
    if (!editor) throw new Error("no editor")
    return editor
  }

  it("tells new items and items with different keys apart", () => {
    expect(editorIdentity(editorOn(null), schema)).toBe("new")
    const a = editorIdentity(editorOn({ pk: { S: "a" }, n: { N: "1" } }), schema)
    expect(editorIdentity(editorOn({ pk: { S: "a" }, n: { N: "2" } }), schema)).toBe(a)
    expect(editorIdentity(editorOn({ pk: { S: "b" } }), schema)).not.toBe(a)
  })

  it("falls back to the whole item before the key schema is known", () => {
    expect(editorIdentity(editorOn({ pk: { S: "a" } }), null)).not.toBe(
      editorIdentity(editorOn({ pk: { S: "b" } }), null),
    )
  })
})
