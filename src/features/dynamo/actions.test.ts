import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type {
  AttributeUpdate,
  ExpectedValue,
  Item,
  PathSegment,
  PutExpectation,
  ScanRequest,
  TableDescription,
} from "../../lib/dynamo"
import {
  conflictingChanges,
  keyId,
  pendingEditCount,
  withPendingValues,
} from "../../lib/dynamoEdits"
import { attributeAt, withAttributeAt } from "../../lib/dynamoPath"
import { setTransport } from "../../lib/ipc"
import { selectedItem } from "../../lib/dynamoTabs"
import { INITIAL_TABS } from "../../lib/queryTabs"
import { useTabsStore } from "../../state/tabsStore"
import {
  applyDynamoEdits,
  applyFromPanel,
  applySelectedItemEdits,
  chooseTable,
  closeItemEditor,
  commitCellEdit,
  commitTreeEdit,
  confirmSave,
  deleteItem,
  discardDynamoEdits,
  discardEditorChanges,
  discardSelectedItemEdits,
  escapeEditor,
  expandTree,
  openDynamoTabFor,
  openItemEditor,
  patchForm,
  reviewActiveEdit,
  reviewEdit,
  reviewSelectedItemEdits,
  runDynamo,
  selectRow,
  setDetailView,
  setDynamoMode,
  setEditorText,
  setPanelJsonMode,
  switchEditorMode,
  toggleTreeNode,
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

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const holdsAll = (item: Item, expected: ExpectedValue[]) =>
  expected.every((e) => same(attributeAt(item, [e.name, ...(e.path ?? [])]), e.value))

/** In-memory DynamoDB with one table keyed on `pk`, enough for paging and safe writes. */
class FakeDynamo {
  items = new Map<string, Item>()
  calls: { command: string; args?: Record<string, unknown> }[] = []
  /** While true, UpdateItem fails as if DynamoDB couldn't be reached. */
  unreachable = false
  /** While true, scans wait in `held` until the test answers them. */
  holdScans = false
  held: (() => void)[] = []

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
      case "dynamo_scan": {
        const page = this.scan(args?.request as ScanRequest)
        if (this.holdScans) await new Promise<void>((resolve) => this.held.push(resolve))
        return page
      }
      case "dynamo_put_item":
        return this.put(
          args?.item as Item,
          args?.expect as PutExpectation,
          (args?.expected ?? []) as ExpectedValue[],
        )
      case "dynamo_get_item":
        return this.items.get(String((args?.key as Item).pk.S)) ?? null
      case "dynamo_delete_item":
        this.items.delete(String((args?.key as Item).pk.S))
        return undefined
      case "dynamo_update_item_attributes":
        return this.update(
          args?.key as Item,
          args?.changes as AttributeUpdate[],
          (args?.expected ?? []) as ExpectedValue[],
        )
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

  /** Conditional like the backend: the item exists and every value is still as expected. */
  private update(key: Item, changes: AttributeUpdate[], expected: ExpectedValue[]) {
    if (this.unreachable) throw { kind: "connection", message: "unreachable" }
    const name = String(key.pk.S)
    const stored = this.items.get(name)
    const pathOf = (c: AttributeUpdate) => [c.name, ...(c.path ?? [])]
    const held = (c: AttributeUpdate) => same(attributeAt(stored ?? {}, pathOf(c)), c.expected)
    if (!stored || !changes.every(held) || !holdsAll(stored, expected)) {
      throw { kind: "query", message: "the item was changed or deleted since it was loaded" }
    }
    const updated = changes.reduce(
      (item, c) =>
        c.path
          ? (withAttributeAt(item, pathOf(c), c.value) ?? item)
          : { ...item, [c.name]: c.value },
      stored,
    )
    this.items.set(name, updated)
    return undefined
  }

  private put(item: Item, expect: PutExpectation, expected: ExpectedValue[]) {
    const key = String(item.pk.S)
    const exists = this.items.has(key)
    const stored = this.items.get(key) ?? {}
    if (
      (expect === "exists" && !exists) ||
      (expect === "not_exists" && exists) ||
      !holdsAll(stored, expected)
    ) {
      throw { kind: "query", message: "The conditional request failed" }
    }
    this.items.set(key, item)
    return undefined
  }
}

let fake: FakeDynamo
let restore: () => void = () => {}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  it("ignores a page that arrives after the tab moved to another table", async () => {
    const id = await openUsers()
    fake.holdScans = true
    const stale = runDynamo(id, "next")
    const switching = chooseTable(id, "orders")
    await flush()
    expect(fake.held).toHaveLength(2)
    const [answerStale, answerFresh] = fake.held
    answerFresh()
    await switching
    answerStale()
    await stale
    expect(tab(id)).toMatchObject({ table: "orders", startKeys: [null], running: false })
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

  it("asks before Edit item or New item replaces unsaved text", async () => {
    const id = await openUsers()
    const [first, second] = tab(id).page?.items ?? []
    openItemEditor(id, first)
    setEditorText(id, '{ "pk": "a", "n": 9 }')
    openItemEditor(id, second)
    expect(tab(id).editor).toMatchObject({
      original: first,
      text: '{ "pk": "a", "n": 9 }',
      discard: { kind: "open", item: second },
    })
    escapeEditor(id)
    expect(tab(id).editor).toMatchObject({ original: first, discard: null })

    openItemEditor(id, null)
    expect(tab(id).editor?.discard).toEqual({ kind: "open", item: null })
    await discardEditorChanges(id)
    expect(tab(id).editor).toMatchObject({ original: null, text: '{\n  "pk": ""\n}' })
    expect(tab(id).editor?.discard).toBeNull()

    openItemEditor(id, second)
    expect(tab(id).editor).toMatchObject({ original: second, discard: null })
  })

  it("keeps the dirty marker right across a mode switch", async () => {
    const id = await openUsers()
    openItemEditor(id, tab(id).page?.items[0] ?? null)
    switchEditorMode(id, "wire")
    expect(tab(id).editor?.text).toBe(tab(id).editor?.initialText)

    setEditorText(id, '{ "pk": { "S": "a" }, "n": { "N": "2" } }')
    switchEditorMode(id, "plain")
    const editor = tab(id).editor
    expect(editor?.initialText).toBe('{\n  "pk": "a",\n  "n": 1\n}')
    expect(editor?.text).not.toBe(editor?.initialText)

    // Changing only the layout and switching back leaves nothing to save.
    setEditorText(id, '{"pk":"a","n":1}')
    switchEditorMode(id, "wire")
    expect(tab(id).editor?.text).toBe(tab(id).editor?.initialText)
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

  it("shows a new item created before any request ran, without running the form", async () => {
    const id = openDynamoTabFor("c1")
    // Query mode doesn't run on table switch, and its empty form isn't a valid request.
    setDynamoMode(id, "query")
    await chooseTable(id, "users")
    expect(tab(id).request).toBeNull()
    openItemEditor(id, null)
    setEditorText(id, '{ "pk": "z", "n": 3 }')
    reviewEdit(id)
    await confirmSave(id)
    expect(tab(id)).toMatchObject({ editor: null, error: null, page: null })
    expect(selectedItem(tab(id))).toEqual({ pk: { S: "z" }, n: { N: "3" } })
    expect(fake.calls.find((c) => c.command === "dynamo_get_item")?.args?.key).toEqual({
      pk: { S: "z" },
    })
    expect(fake.calls.some((c) => c.command === "dynamo_query")).toBe(false)

    await expect(deleteItem(id, { pk: { S: "z" } })).resolves.toBe(true)
    expect(tab(id)).toMatchObject({ error: null, detail: null })
    expect(fake.items.has("z")).toBe(false)
  })
})

describe("inline edits", () => {
  it("stages typed values, then applies them and re-reads the page", async () => {
    const id = await openUsers()
    expect(commitCellEdit(id, 0, "n", "x")).toMatch(/isn't a number/)
    expect(commitCellEdit(id, 0, "pk", "z")).toMatch(/item editor/)
    expect(commitCellEdit(id, 0, "n", "5")).toBeNull()
    expect(commitCellEdit(id, 1, "note", "hi")).toBeNull()
    expect(pendingEditCount(tab(id).edits)).toBe(2)
    // The page under the edits is kept until they are applied or discarded.
    await expect(runDynamo(id, "next")).resolves.toBeNull()
    expect(fake.calls.filter((c) => c.command === "dynamo_scan")).toHaveLength(1)

    await applyDynamoEdits(id)
    const updates = fake.calls.filter((c) => c.command === "dynamo_update_item_attributes")
    expect(updates.map((c) => c.args)).toEqual([
      {
        connectionId: "c1",
        table: "users",
        key: { pk: { S: "a" } },
        changes: [{ name: "n", value: { N: "5" }, expected: { N: "1" } }],
      },
      {
        connectionId: "c1",
        table: "users",
        key: { pk: { S: "b" } },
        changes: [{ name: "note", value: { S: "hi" }, expected: null }],
      },
    ])
    expect(tab(id)).toMatchObject({ applying: false, edits: {} })
    expect(tab(id).page?.items.map((i) => i.n)).toEqual([{ N: "5" }, { N: "1" }])
    expect(tab(id).page?.items[1].note).toEqual({ S: "hi" })
  })

  it("keeps the edits of items that failed and drops the written ones", async () => {
    const id = await openUsers()
    commitCellEdit(id, 0, "n", "5")
    commitCellEdit(id, 1, "n", "6")
    fake.items.set("b", { pk: { S: "b" }, n: { N: "9" } })
    await applyDynamoEdits(id)
    expect(fake.items.get("a")?.n).toEqual({ N: "5" })
    expect(fake.items.get("b")?.n).toEqual({ N: "9" })
    const left = Object.values(tab(id).edits)
    expect(left.map((e) => e.key)).toEqual([{ pk: { S: "b" } }])
    // Edits are keyed by item, so they still apply to the refreshed page.
    expect(tab(id).page?.items.map((i) => i.pk.S)).toEqual(["a", "b"])

    discardDynamoEdits(id)
    expect(tab(id).edits).toEqual({})
  })

  it("marks refused items with the error kind and discards one item's edits alone", async () => {
    const id = await openUsers()
    commitCellEdit(id, 0, "n", "5")
    commitCellEdit(id, 1, "n", "6")
    fake.items.set("a", { pk: { S: "a" }, n: { N: "7" } })
    fake.items.set("b", { pk: { S: "b" }, n: { N: "9" } })
    await applyDynamoEdits(id)
    expect(Object.values(tab(id).edits).map((e) => e.failed)).toEqual(["query", "query"])
    // The pending value still covers what the server holds now.
    expect(tab(id).page?.items[1].n).toEqual({ N: "9" })

    selectRow(id, 1)
    discardSelectedItemEdits(id)
    expect(Object.values(tab(id).edits).map((e) => e.key)).toEqual([{ pk: { S: "a" } }])
    // Editing the item again keeps the failure mark, so it can't be handed to the editor.
    commitCellEdit(id, 0, "n", "8")
    expect(Object.values(tab(id).edits)[0].failed).toBe("query")
  })

  it("forgets edits of deleted items", async () => {
    const id = await openUsers()
    commitCellEdit(id, 0, "n", "5")
    await deleteItem(id, tab(id).page?.items[0] as Item)
    expect(tab(id).edits).toEqual({})
  })
})

describe("item tree", () => {
  const service = {
    M: {
      numbers: {
        L: [
          { M: { senderNumber: { S: "010" }, on: { BOOL: true } } },
          { M: { senderNumber: { S: "011" }, on: { BOOL: false } } },
        ],
      },
    },
  }
  const numberPath = ["senderService", "numbers", 1, "senderNumber"]
  const itemA = keyId({ pk: { S: "a" } })
  const commit = (id: string, path: PathSegment[], jsonPath: PathSegment[], text: string) =>
    commitTreeEdit(id, itemA, path, jsonPath, text)

  async function openNested(): Promise<string> {
    fake.items.set("a", {
      pk: { S: "a" },
      n: { N: "1" },
      senderService: service,
      config: { S: '{"size":12}' },
    })
    const id = await openUsers()
    selectRow(id, 0)
    return id
  }

  it("reviews, then writes nested edits with a condition on each loaded value", async () => {
    const id = await openNested()
    expect(commit(id, ["pk"], [], "z")).toMatch(/table key/)
    expect(commit(id, ["n"], [], "x")).toMatch(/isn't a number/)
    expect(commit(id, numberPath, [], "012")).toBeNull()
    expect(commit(id, ["config"], ["size"], "13")).toBeNull()
    // A grid edit of another item stays pending while this one is applied.
    commitCellEdit(id, 1, "n", "7")

    reviewSelectedItemEdits(id)
    expect(tab(id).panel.reviewing).toBe(true)
    reviewActiveEdit()
    await flush()
    const update = fake.calls.find((c) => c.command === "dynamo_update_item_attributes")
    expect(update?.args).toMatchObject({
      key: { pk: { S: "a" } },
      changes: [
        {
          name: "senderService",
          path: ["numbers", 1, "senderNumber"],
          value: { S: "012" },
          expected: { S: "011" },
        },
        { name: "config", value: { S: '{"size":13}' }, expected: { S: '{"size":12}' } },
      ],
    })
    expect(attributeAt(fake.items.get("a") as Item, numberPath)).toEqual({ S: "012" })
    expect(tab(id).panel.reviewing).toBe(false)
    expect(Object.values(tab(id).edits).map((e) => e.key)).toEqual([{ pk: { S: "b" } }])
  })

  it("leaves the edit pending and marked when the value changed on the server", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    const stored = fake.items.get("a") as Item
    fake.items.set("a", withAttributeAt(stored, numberPath, { S: "099" }) as Item)
    await applySelectedItemEdits(id)
    expect(Object.values(tab(id).edits).map((e) => e.failed)).toEqual(["query"])
    expect(attributeAt(fake.items.get("a") as Item, numberPath)).toEqual({ S: "099" })
  })

  it("hands pending edits to Edit: the diff shows them and one save writes them", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    commitCellEdit(id, 0, "n", "5")
    openItemEditor(id, selectedItem(tab(id)))
    const editor = tab(id).editor
    expect(editor).toMatchObject({ carried: 2, mode: "plain" })
    expect(editor?.text).toContain('"senderNumber": "012"')
    expect(editor?.text).not.toBe(editor?.initialText)
    // The changes now live in the editor only.
    expect(tab(id).edits).toEqual({})
    expect(commit(id, ["n"], [], "6")).toBe("Close the item editor first")

    reviewEdit(id)
    expect(tab(id).editor?.stage).toBe("confirm")
    await confirmSave(id)
    const put = fake.calls.find((c) => c.command === "dynamo_put_item")
    expect(put?.args).toMatchObject({ expect: "exists" })
    const saved = fake.items.get("a") as Item
    expect(saved.n).toEqual({ N: "5" })
    expect(attributeAt(saved, numberPath)).toEqual({ S: "012" })
  })

  it("drops handed-over edits when the editor is discarded", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    openItemEditor(id, selectedItem(tab(id)))
    closeItemEditor(id)
    expect(tab(id).editor?.discard).toEqual({ kind: "close" })
    await discardEditorChanges(id)
    expect(tab(id)).toMatchObject({ editor: null, edits: {} })
    expect(attributeAt(fake.items.get("a") as Item, numberPath)).toEqual({ S: "011" })
    expect(fake.calls.some((c) => c.command === "dynamo_put_item")).toBe(false)
  })

  it("keeps refused edits out of the editor", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    fake.items.set("a", { pk: { S: "a" } })
    await applySelectedItemEdits(id)
    openItemEditor(id, selectedItem(tab(id)))
    expect(tab(id).editor).toBeNull()
    expect(pendingEditCount(tab(id).edits)).toBe(1)
  })

  it("opens the editor in the panel's JSON mode and keeps the editor's choice", async () => {
    const id = await openNested()
    setPanelJsonMode(id, "wire")
    openItemEditor(id, selectedItem(tab(id)))
    expect(tab(id).editor?.mode).toBe("wire")
    switchEditorMode(id, "plain")
    expect(tab(id).panel.mode).toBe("plain")
  })

  const rule = (id: string, on = false) => ({ M: { id: { S: id }, on: { BOOL: on } } })
  const serverHas = (update: (item: Item) => Item) =>
    fake.items.set("a", update(fake.items.get("a") as Item))

  it("refuses a write into a list that shifted, and doesn't lay it over the new one", async () => {
    const id = await openNested()
    serverHas((item) => ({ ...item, rules: { L: [rule("r1"), rule("r2")] } }))
    await runDynamo(id, "current")
    selectRow(id, 0)
    expect(commit(id, ["rules", 0, "on"], [], "true")).toBeNull()
    // Someone removes r1; r2.on is false too, so the edited leaf alone still matches.
    serverHas((item) => ({ ...item, rules: { L: [rule("r2")] } }))
    await applySelectedItemEdits(id)
    const update = fake.calls.find((c) => c.command === "dynamo_update_item_attributes")
    expect(update?.args?.expected).toEqual([
      { name: "rules", value: { L: [rule("r1"), rule("r2")] } },
    ])
    expect(fake.items.get("a")?.rules).toEqual({ L: [rule("r2")] })
    expect(Object.values(tab(id).edits).map((e) => e.failed)).toEqual(["query"])
    // After the refresh the change is a conflict: shown as pending, not applied to r2.
    const loaded = selectedItem(tab(id)) as Item
    const edit = Object.values(tab(id).edits)[0]
    expect(conflictingChanges(edit, loaded)).toHaveLength(1)
    expect(withPendingValues(loaded, edit).rules).toEqual({ L: [rule("r2")] })
  })

  it("refuses the hand-off when a refresh shows a newer value", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    serverHas((item) => withAttributeAt(item, numberPath, { S: "099" }) as Item)
    await runDynamo(id, "current")
    selectRow(id, 0)
    openItemEditor(id, selectedItem(tab(id)))
    expect(tab(id).editor).toBeNull()
    expect(pendingEditCount(tab(id).edits)).toBe(1)
  })

  it("refuses the hand-off when an edited path no longer resolves", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    serverHas((item) => ({ ...item, senderService: { M: { numbers: { L: [] } } } }))
    await runDynamo(id, "current")
    selectRow(id, 0)
    openItemEditor(id, selectedItem(tab(id)))
    expect(tab(id).editor).toBeNull()
    expect(pendingEditCount(tab(id).edits)).toBe(1)
  })

  it("keeps a failed item out of the editor after later edits", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    fake.unreachable = true
    await applySelectedItemEdits(id)
    expect(commit(id, ["n"], [], "4")).toBeNull()
    expect(Object.values(tab(id).edits)[0].failed).toBe("connection")
    openItemEditor(id, selectedItem(tab(id)))
    expect(tab(id).editor).toBeNull()
  })

  it("saves handed-over edits only while their starting values hold, keeping the text on refusal", async () => {
    const id = await openNested()
    commit(id, numberPath, [], "012")
    openItemEditor(id, selectedItem(tab(id)))
    const text = tab(id).editor?.text
    serverHas((item) => withAttributeAt(item, numberPath, { S: "099" }) as Item)
    reviewEdit(id)
    await confirmSave(id)
    const put = fake.calls.find((c) => c.command === "dynamo_put_item")
    expect(put?.args?.expected).toEqual([
      { name: "senderService", path: ["numbers", 1, "senderNumber"], value: { S: "011" } },
      { name: "senderService", path: ["numbers"], value: service.M.numbers },
    ])
    expect(tab(id).editor).toMatchObject({ stage: "confirm", saving: false, carried: 1, text })
    expect(tab(id).editor?.error).toMatch(/changed elsewhere/)
    expect(attributeAt(fake.items.get("a") as Item, numberPath)).toEqual({ S: "099" })
  })

  it("refuses a tree value committed after another item was selected", async () => {
    const id = await openNested()
    selectRow(id, 1)
    expect(commit(id, ["n"], [], "9")).toBe("This item is no longer selected")
    expect(commitTreeEdit(id, keyId({ pk: { S: "b" } }), ["n"], [], "9")).toBeNull()
    expect(Object.values(tab(id).edits).map((e) => e.key)).toEqual([{ pk: { S: "b" } }])
  })

  it("applies from the item panel only that item's changes", async () => {
    const id = await openNested()
    commitCellEdit(id, 1, "n", "7")
    applyFromPanel(id)
    expect(tab(id).panel.reviewing).toBe(false)
    expect(fake.calls.some((c) => c.command === "dynamo_update_item_attributes")).toBe(false)
    commit(id, ["n"], [], "5")
    applyFromPanel(id)
    expect(tab(id).panel.reviewing).toBe(true)
    applyFromPanel(id)
    await flush()
    const updates = fake.calls.filter((c) => c.command === "dynamo_update_item_attributes")
    expect(updates.map((c) => c.args?.key)).toEqual([{ pk: { S: "a" } }])
  })

  it("keeps the review open when Apply can't run yet", async () => {
    const id = await openNested()
    commit(id, ["n"], [], "5")
    reviewSelectedItemEdits(id)
    useTabsStore.getState().updateDynamo(id, (t) => ({ ...t, running: true }))
    await applySelectedItemEdits(id)
    expect(tab(id).panel.reviewing).toBe(true)
    expect(fake.calls.some((c) => c.command === "dynamo_update_item_attributes")).toBe(false)
  })

  it("keeps the view and expansion between items, and resets expansion for another table", async () => {
    const id = await openNested()
    setDetailView(id, "json")
    toggleTreeNode(id, ["senderService", "numbers"], false)
    expandTree(id, true)
    selectRow(id, 1)
    expect(tab(id).panel).toMatchObject({ view: "json", tree: { base: "all" } })
    discardSelectedItemEdits(id)
    await chooseTable(id, "orders")
    expect(tab(id).panel).toMatchObject({ view: "json", tree: { base: "first", open: {} } })
  })
})
