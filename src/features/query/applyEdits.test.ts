import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useToastStore } from "../../components/ui/toastStore"
import { addInsert, setCellEdit, setInsertValue, toggleRowDelete } from "../../lib/gridEdits"
import type { GridEdits } from "../../lib/gridEdits"
import { setTransport } from "../../lib/ipc"
import type { RowsResult, SchemaSnapshot } from "../../lib/mysql"
import { INITIAL_TABS, type QueryTab } from "../../lib/queryTabs"
import { emptySession, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { applyActiveEdits } from "./actions"
import { answerApplyConfirm, useApplyConfirmStore } from "./applyConfirm"

const users: RowsResult = {
  kind: "rows",
  columns: [
    { name: "id", typeName: "INT", table: null, nullable: false },
    { name: "email", typeName: "VARCHAR", table: null, nullable: false },
  ],
  rows: [
    [
      { t: "int", v: "1" },
      { t: "str", v: "a@x" },
    ],
    [
      { t: "int", v: "2" },
      { t: "str", v: "b@x" },
    ],
  ],
  rowCount: 2,
  truncated: false,
  elapsedMs: 1,
  reconnected: false,
  statement: "select id, email from users",
}

const schema: SchemaSnapshot = {
  database: "app",
  fetchedAt: "2026-01-01T00:00:00Z",
  tables: [
    {
      name: "users",
      kind: "table",
      columns: ["id", "email"].map((name) => ({
        name,
        typeName: "varchar(255)",
        nullable: false,
        isPrimary: name === "id",
        isAutoIncrement: false,
        defaultValue: null,
      })),
    },
  ],
}

let calls: { command: string; args?: Record<string, unknown> }[] = []
let backupFails = false
let restore: () => void = () => {}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  calls = []
  backupFails = false
  useToastStore.setState({ toasts: [] })
  useApplyConfirmStore.setState({ pending: null })
  useTabsStore.setState({ ...INITIAL_TABS })
  useSessionsStore.setState({
    sessions: {
      c1: {
        ...emptySession(),
        state: "connected",
        currentDatabase: "app",
        databases: ["app"],
        schemas: { app: schema },
      },
    },
  })
  restore = setTransport(async (command, args) => {
    calls.push({ command, args })
    switch (command) {
      case "mysql_query":
        return [users]
      case "mysql_preview_changes":
        return { statements: ["DELETE FROM `app`.`users` WHERE `id` <=> 2 LIMIT 2"], warning: null }
      case "mysql_apply_changes":
        if (backupFails && !args?.skipBackup) {
          throw { kind: "backup_failed", message: "the disk is full" }
        }
        return { affectedRows: 1, elapsedMs: 1 }
      default:
        throw { kind: "not_found", message: command }
    }
  })
})
afterEach(() => {
  answerApplyConfirm(false)
  restore()
})

/** Opens a tab with the users result and applies `edit` to its pending edits. */
async function tabWith(edit: (edits: GridEdits) => GridEdits): Promise<string> {
  const id = useTabsStore.getState().open("c1", "app")
  await useTabsStore.getState().run(id, users.statement)
  useTabsStore.getState().updateEdits(id, 0, edit)
  calls = []
  return id
}

const deleteRow2 = (edits: GridEdits) => toggleRowDelete(edits, 1)
const applies = () => calls.filter((c) => c.command === "mysql_apply_changes")
const toasts = () => useToastStore.getState().toasts.map((t) => t.message)
const tab = (id: string) => useTabsStore.getState().tabs.find((t) => t.id === id) as QueryTab

/** Waits for the dialog of `kind`; an apply dialog also until its preview is no longer loading. */
async function waitForDialog(kind: "apply" | "backup-failed") {
  const ready = () => {
    const pending = useApplyConfirmStore.getState().pending
    return (
      pending?.kind === kind && (pending.kind !== "apply" || pending.preview.status !== "loading")
    )
  }
  for (let i = 0; i < 20 && !ready(); i++) await flush()
  expect(ready()).toBe(true)
}

describe("applyActiveEdits", () => {
  it("asks first for deletes, shows the preview and applies on confirm", async () => {
    await tabWith(deleteRow2)
    const done = applyActiveEdits()
    await waitForDialog("apply")
    await flush()
    const pending = useApplyConfirmStore.getState().pending
    expect(pending).toMatchObject({
      kind: "apply",
      request: { table: "app.users", counts: { updates: 0, deletes: 1, inserts: 0 } },
      preview: { status: "ready", statements: [expect.stringContaining("DELETE")] },
    })
    expect(calls.find((c) => c.command === "mysql_preview_changes")?.args).toMatchObject({
      database: "app",
      table: "users",
      changes: [{ type: "delete", key: { id: { t: "int", v: "2" } } }],
    })
    expect(applies()).toHaveLength(0)
    answerApplyConfirm(true)
    await done
    expect(applies()).toHaveLength(1)
    expect(applies()[0].args).not.toHaveProperty("skipBackup")
    expect(toasts()).toContain("Applied changes · 1 row affected · 1 row moved to Trash")
  })

  it("applies nothing when the confirmation is cancelled", async () => {
    const id = await tabWith((e) => setCellEdit(e, users.rows, 0, 1, { t: "str", v: "c@x" }))
    const done = applyActiveEdits()
    await waitForDialog("apply")
    answerApplyConfirm(false)
    await done
    expect(applies()).toHaveLength(0)
    expect(tab(id).edits[0]?.updates).toBeDefined()
  })

  it("applies inserts alone without asking", async () => {
    await tabWith((e) => setInsertValue(addInsert(e, "n1"), "n1", 1, { t: "str", v: "n@x" }))
    await applyActiveEdits()
    expect(useApplyConfirmStore.getState().pending).toBeNull()
    expect(calls.some((c) => c.command === "mysql_preview_changes")).toBe(false)
    expect(applies()).toHaveLength(1)
    expect(toasts()).toContain("Applied changes · 1 row affected")
  })

  it("does not apply edits that changed while the dialog was open", async () => {
    const id = await tabWith(deleteRow2)
    const done = applyActiveEdits()
    await waitForDialog("apply")
    useTabsStore.getState().updateEdits(id, 0, (e) => toggleRowDelete(e, 0))
    answerApplyConfirm(true)
    await done
    expect(applies()).toHaveLength(0)
    expect(toasts()[0]).toMatch(/edited while the dialog was open/)
  })

  it("offers to delete without a backup and retries only with skipBackup on yes", async () => {
    backupFails = true
    await tabWith(deleteRow2)
    const done = applyActiveEdits()
    await waitForDialog("apply")
    answerApplyConfirm(true)
    await waitForDialog("backup-failed")
    expect(useApplyConfirmStore.getState().pending).toMatchObject({
      request: { table: "app.users", message: "the disk is full", deletes: 1 },
    })
    answerApplyConfirm(true)
    await done
    expect(applies()).toHaveLength(2)
    expect(applies()[1].args).toMatchObject({ skipBackup: true })
    expect(toasts()).toContain("Applied changes · 1 row affected · 1 row deleted without a backup")
  })

  it("keeps the edits when deleting without a backup is declined", async () => {
    backupFails = true
    const id = await tabWith(deleteRow2)
    const done = applyActiveEdits()
    await waitForDialog("apply")
    answerApplyConfirm(true)
    await waitForDialog("backup-failed")
    answerApplyConfirm(false)
    await done
    expect(applies()).toHaveLength(1)
    expect(tab(id).edits[0]?.deletes).toEqual([1])
    expect(toasts()).toEqual([])
  })

  it("does not delete without a backup when the edits changed during that dialog", async () => {
    backupFails = true
    const id = await tabWith(deleteRow2)
    const done = applyActiveEdits()
    await waitForDialog("apply")
    answerApplyConfirm(true)
    await waitForDialog("backup-failed")
    useTabsStore.getState().updateEdits(id, 0, (e) => toggleRowDelete(e, 0))
    answerApplyConfirm(true)
    await done
    expect(applies()).toHaveLength(1)
    expect(toasts()).toEqual([expect.stringMatching(/edited while the dialog was open/)])
  })

  it("applies nothing when the tab closes while the dialog is open", async () => {
    const id = await tabWith(deleteRow2)
    const done = applyActiveEdits()
    await waitForDialog("apply")
    useTabsStore.getState().close(id)
    answerApplyConfirm(true)
    await done
    expect(applies()).toHaveLength(0)
    expect(toasts()).toEqual([expect.stringMatching(/tab or result was closed/)])
  })

  it("cancels the open dialog when another tab applies", async () => {
    const first = await tabWith(deleteRow2)
    const second = await tabWith((e) => setCellEdit(e, users.rows, 0, 1, { t: "str", v: "z@x" }))
    useTabsStore.setState({ activeId: first })
    const firstDone = applyActiveEdits()
    await waitForDialog("apply")
    useTabsStore.setState({ activeId: second })
    const secondDone = applyActiveEdits()
    await firstDone
    expect(applies()).toHaveLength(0)
    await flush()
    expect(useApplyConfirmStore.getState().pending).toMatchObject({
      request: { counts: { updates: 1, deletes: 0 } },
    })
    answerApplyConfirm(true)
    await secondDone
    expect(applies()).toHaveLength(1)
    expect(applies()[0].args?.changes).toEqual([expect.objectContaining({ type: "update" })])
    expect(tab(first).edits[0]?.deletes).toEqual([1])
  })

  it("reports other failures as before, without the backup dialog", async () => {
    await tabWith(deleteRow2)
    restore()
    restore = setTransport(async (command) => {
      if (command === "mysql_preview_changes") throw { kind: "connection", message: "gone" }
      if (command === "mysql_apply_changes") throw { kind: "query", message: "boom" }
      return [users]
    })
    const done = applyActiveEdits()
    await waitForDialog("apply")
    await flush()
    expect(useApplyConfirmStore.getState().pending).toMatchObject({
      preview: { status: "error", message: "gone" },
    })
    answerApplyConfirm(true)
    await done
    expect(useApplyConfirmStore.getState().pending).toBeNull()
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      tone: "error",
      message: "Couldn't apply the changes",
      detail: "boom",
    })
  })
})
