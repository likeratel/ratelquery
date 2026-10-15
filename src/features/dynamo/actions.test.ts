import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Item, PutExpectation, ScanRequest, TableDescription } from "../../lib/dynamo"
import { setTransport } from "../../lib/ipc"
import { INITIAL_TABS } from "../../lib/queryTabs"
import { useTabsStore } from "../../state/tabsStore"
import {
  chooseTable,
  closeItemEditor,
  confirmSave,
  deleteItem,
  discardEditorChanges,
  escapeEditor,
  openDynamoTabFor,
  openItemEditor,
  patchForm,
  reviewEdit,
  runDynamo,
  setDynamoMode,
  setEditorText,
  switchEditorMode,
} from "./actions"
import { useDynamoCatalog } from "./catalogStore"

const description: TableDescription = {
  name: "users",
  status: "ACTIVE",
  keySchema: { hash: { name: "pk", type: "S" }, range: null },
  indexes: [],
  itemCount: 3,
  sizeBytes: 10,
  billingMode: null,
}

/** In-memory DynamoDB with one table keyed on `pk`, enough for paging and safe writes. */
class FakeDynamo {
  items = new Map<string, Item>()
  calls: { command: string; args?: Record<string, unknown> }[] = []

  constructor(names: string[]) {
    for (const name of names) this.items.set(name, { pk: { S: name }, n: { N: "1" } })
  }

  handle = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ command, args })
    switch (command) {
      case "dynamo_list_tables":
        return ["users"]
      case "dynamo_describe_table":
        return description
      case "dynamo_scan":
        return this.scan(args?.request as ScanRequest)
      case "dynamo_put_item":
        return this.put(args?.item as Item, args?.expect as PutExpectation)
      case "dynamo_delete_item":
        this.items.delete(String((args?.key as Item).pk.S))
        return undefined
      default:
        throw { kind: "not_found", message: command }
    }
  }

  private scan(request: ScanRequest) {
    const keys = [...this.items.keys()].sort()
    const after = request.startKey ? String(request.startKey.pk.S) : null
    const rest = after === null ? keys : keys.filter((k) => k > after)
    const limit = request.limit ?? 100
    const items = rest.slice(0, limit).map((k) => this.items.get(k) as Item)
    const more = rest.length > limit
    return {
      items,
      lastKey: more ? { pk: items[items.length - 1].pk } : null,
      count: items.length,
      scannedCount: items.length,
      elapsedMs: 4,
    }
  }

  private put(item: Item, expect: PutExpectation) {
    const key = String(item.pk.S)
    const exists = this.items.has(key)
    if ((expect === "exists" && !exists) || (expect === "not_exists" && exists)) {
      throw { kind: "query", message: "The conditional request failed" }
    }
    this.items.set(key, item)
    return undefined
  }
}

let fake: FakeDynamo
let restore: () => void = () => {}

const tab = (id: string) => {
  const found = useTabsStore.getState().tabs.find((t) => t.id === id)
  if (found?.kind !== "dynamo") throw new Error("not a dynamo tab")
  return found
}

async function openUsers(limit = "2"): Promise<string> {
  const id = openDynamoTabFor("c1")
  patchForm(id, { limit })
  await chooseTable(id, "users")
  return id
}

beforeEach(() => {
  useTabsStore.setState({ ...INITIAL_TABS })
  useDynamoCatalog.setState({ catalogs: {} })
  fake = new FakeDynamo(["a", "b", "c"])
  restore = setTransport(fake.handle)
})
afterEach(() => restore())

describe("browsing", () => {
  it("lists tables, describes the chosen one and scans its first page", async () => {
    const id = await openUsers()
    expect(useDynamoCatalog.getState().catalogs.c1.tables).toEqual(["users"])
    expect(tab(id)).toMatchObject({ table: "users", title: "users", startKeys: [null] })
    expect(tab(id).page?.items.map((i) => i.pk.S)).toEqual(["a", "b"])
  })

  it("pages forward and back with the request that produced the page", async () => {
    const id = await openUsers()
    patchForm(id, { limit: "50" })
    await runDynamo(id, "next")
    expect(tab(id).page?.items.map((i) => i.pk.S)).toEqual(["c"])
    expect(fake.calls.at(-1)?.args?.request).toEqual({
      table: "users",
      limit: 2,
      startKey: { pk: { S: "b" } },
    })
    await runDynamo(id, "previous")
    expect(tab(id).page?.items.map((i) => i.pk.S)).toEqual(["a", "b"])
  })

  it("shows form errors on the tab without calling the backend", async () => {
    const id = await openUsers()
    const before = fake.calls.length
    setDynamoMode(id, "query")
    await runDynamo(id, "first")
    expect(tab(id).error).toEqual({
      kind: "invalid_input",
      message: "Enter a value for partition key pk",
    })
    expect(fake.calls).toHaveLength(before)
  })
})

describe("editing", () => {
  it("reviews the diff, then saves with attribute_exists and refreshes", async () => {
    const id = await openUsers()
    openItemEditor(id, tab(id).page?.items[0] ?? null)
    expect(tab(id).editor?.mode).toBe("plain")
    setEditorText(id, '{ "pk": "a", "n": 2, "email": "a@x" }')
    reviewEdit(id)
    expect(tab(id).editor?.stage).toBe("confirm")
    await confirmSave(id)
    const put = fake.calls.find((c) => c.command === "dynamo_put_item")
    expect(put?.args).toMatchObject({
      table: "users",
      item: { pk: { S: "a" }, n: { N: "2" }, email: { S: "a@x" } },
      expect: "exists",
    })
    expect(tab(id).editor).toBeNull()
    expect(tab(id).selected).toBe(0)
    expect(tab(id).page?.items[0].email).toEqual({ S: "a@x" })
  })

  it("refuses unchanged items and missing keys", async () => {
    const id = await openUsers()
    openItemEditor(id, tab(id).page?.items[0] ?? null)
    reviewEdit(id)
    expect(tab(id).editor).toMatchObject({ stage: "edit", error: "Nothing changed" })
    setEditorText(id, '{ "n": 1 }')
    reviewEdit(id)
    expect(tab(id).editor?.error).toBe("Missing partition key pk (S)")
  })

  it("creates new items with attribute_not_exists and reports conflicts", async () => {
    const id = await openUsers()
    openItemEditor(id, null)
    expect(tab(id).editor?.text).toBe('{\n  "pk": ""\n}')
    setEditorText(id, '{ "pk": "b" }')
    reviewEdit(id)
    await confirmSave(id)
    expect(fake.calls.at(-1)?.args?.expect).toBe("not_exists")
    expect(tab(id).editor).toMatchObject({ saving: false, stage: "confirm" })
    expect(tab(id).editor?.error).toMatch(/conditional request failed/)
  })

  it("keeps sets in wire mode and refuses plain mode for them", async () => {
    const id = await openUsers()
    openItemEditor(id, { pk: { S: "a" }, tags: { SS: ["x"] } })
    expect(tab(id).editor?.mode).toBe("wire")
    switchEditorMode(id, "plain")
    expect(tab(id).editor).toMatchObject({ mode: "wire" })
    expect(tab(id).editor?.error).toMatch(/tags: String sets become lists/)
  })

  it("asks before Esc throws away unsaved text, and closes clean editors at once", async () => {
    const id = await openUsers()
    openItemEditor(id, tab(id).page?.items[0] ?? null)
    escapeEditor(id)
    expect(tab(id).editor).toBeNull()

    openItemEditor(id, tab(id).page?.items[0] ?? null)
    setEditorText(id, '{ "pk": "a", "n": 5 }')
    escapeEditor(id)
    expect(tab(id).editor?.discard).toEqual({ kind: "close" })
    escapeEditor(id)
    expect(tab(id).editor).toMatchObject({ discard: null, text: '{ "pk": "a", "n": 5 }' })
    closeItemEditor(id)
    await discardEditorChanges(id)
    expect(tab(id).editor).toBeNull()
  })

  it("switches tables only after the discard is confirmed", async () => {
    const id = await openUsers()
    openItemEditor(id, null)
    setEditorText(id, '{ "pk": "new" }')
    await chooseTable(id, "orders")
    expect(tab(id)).toMatchObject({
      table: "users",
      editor: { discard: { kind: "table", table: "orders" } },
    })
    await discardEditorChanges(id)
    expect(tab(id)).toMatchObject({ table: "orders", editor: null })
  })

  it("deletes by table key and refreshes the page", async () => {
    const id = await openUsers()
    const first = tab(id).page?.items[0]
    if (!first) throw new Error("no item")
    await expect(deleteItem(id, first)).resolves.toBe(true)
    expect(fake.calls.find((c) => c.command === "dynamo_delete_item")?.args?.key).toEqual({
      pk: { S: "a" },
    })
    expect(tab(id).page?.items.map((i) => i.pk.S)).toEqual(["b", "c"])
  })
})
