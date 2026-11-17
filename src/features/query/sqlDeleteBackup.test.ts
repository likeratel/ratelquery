import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useToastStore } from "../../components/ui/toastStore"
import { setTransport } from "../../lib/ipc"
import type { DeletePlanEntry, ExecResult, QueryResponseItem } from "../../lib/mysql"
import { INITIAL_TABS, appendRun, createTab, type QueryTab } from "../../lib/queryTabs"
import { emptySession, useSessionsStore } from "../../state/sessionsStore"
import { useTabsStore } from "../../state/tabsStore"
import { runActiveTab } from "./actions"
import { answerDeleteBackup, useDeleteBackupStore } from "./deleteBackupConfirm"

const SCRIPT =
  "INSERT INTO log VALUES (1);\nDELETE FROM big WHERE id > 0;\nDELETE t FROM t JOIN u ON t.id = u.id WHERE u.gone = 1"

const exec = (statement: string, extra: Partial<ExecResult> = {}): ExecResult => ({
  kind: "exec",
  affectedRows: 1,
  lastInsertId: null,
  elapsedMs: 1,
  reconnected: false,
  statement,
  ...extra,
})

const stopAt = (statementIndex: number, resumeToken: string): QueryResponseItem => ({
  kind: "backup_stopped",
  statementIndex,
  reason: "the disk is full",
  statement: "DELETE",
  elapsedMs: 0,
  resumeToken,
})

const unsupported: DeletePlanEntry = {
  index: 2,
  backup: "unsupported",
  reason: "a DELETE over several tables can't be backed up",
  statement: "DELETE t FROM t JOIN u ON t.id = u.id WHERE u.gone = 1",
}

let calls: { command: string; args?: Record<string, unknown> }[] = []
let plan: DeletePlanEntry[] = []
let responses: (QueryResponseItem[] | "fail")[] = []
let restore: () => void = () => {}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const queries = () => calls.filter((c) => c.command === "mysql_query")
const tab = () => useTabsStore.getState().tabs[0] as QueryTab
const toasts = () => useToastStore.getState().toasts.map((t) => t.message)

async function waitForQuestion(kind: "unsupported" | "stopped") {
  for (let i = 0; i < 20 && useDeleteBackupStore.getState().pending?.kind !== kind; i++) {
    await flush()
  }
  expect(useDeleteBackupStore.getState().pending?.kind).toBe(kind)
}

beforeEach(() => {
  calls = []
  plan = [{ index: 1, backup: "ok", reason: null, statement: "DELETE FROM big WHERE id > 0" }]
  responses = []
  useToastStore.setState({ toasts: [] })
  useDeleteBackupStore.setState({ pending: null })
  useTabsStore.setState({ ...INITIAL_TABS })
  useSessionsStore.setState({
    sessions: { c1: { ...emptySession(), state: "connected", currentDatabase: "app" } },
  })
  restore = setTransport(async (command, args) => {
    calls.push({ command, args })
    if (command === "mysql_delete_plan") return plan
    if (command === "mysql_query") {
      const next = responses.shift()
      if (next === "fail")
        throw { kind: "invalid_input", message: "Run the script again from the start." }
      return next ?? []
    }
    if (command === "mysql_release_resume") return null
    if (command === "trash_list") return []
    throw { kind: "not_found", message: command }
  })
  const id = useTabsStore.getState().open("c1", "app")
  useTabsStore.getState().setSql(id, SCRIPT)
})
afterEach(() => {
  answerDeleteBackup(false)
  restore()
})

describe("running DELETE statements with a trash backup", () => {
  it("runs right away when every DELETE can be backed up", async () => {
    responses = [[exec("INSERT"), exec("DELETE", { trashedRows: 1, trashId: "x" })]]
    await runActiveTab("selection", { selectedText: "" })
    // The rows went to the Trash, so its list is reloaded for the sidebar count.
    expect(calls.map((c) => c.command)).toEqual(["mysql_delete_plan", "mysql_query", "trash_list"])
    expect(calls[0].args).toEqual({ sql: SCRIPT })
    expect(queries()[0].args?.options).not.toHaveProperty("deleteBackup")
    expect(tab().results).toHaveLength(2)
  })

  it("asks first about DELETEs that can't be backed up and runs nothing on cancel", async () => {
    plan = [...plan, unsupported]
    const done = runActiveTab("selection", { selectedText: "" })
    await waitForQuestion("unsupported")
    expect(useDeleteBackupStore.getState().pending).toMatchObject({ entries: [unsupported] })
    answerDeleteBackup(false)
    await done
    expect(queries()).toHaveLength(0)
  })

  it("skips the backup only for the statements the user agreed to", async () => {
    plan = [...plan, unsupported]
    responses = [[exec("INSERT"), exec("DELETE"), exec("DELETE t")]]
    const done = runActiveTab("selection", { selectedText: "" })
    await waitForQuestion("unsupported")
    answerDeleteBackup(true)
    await done
    expect(queries()[0].args?.options).toMatchObject({ deleteBackup: { skip: [2] } })
  })

  it("continues from the stopped statement only when the user agrees", async () => {
    responses = [
      [
        exec("INSERT"),
        {
          kind: "backup_stopped",
          statementIndex: 1,
          reason: "it deletes more than the 10000 rows one backup can hold",
          statement: "DELETE FROM big WHERE id > 0",
          elapsedMs: 0,
          resumeToken: "tok",
        },
      ],
      [exec("DELETE FROM big WHERE id > 0", { affectedRows: 20000 }), exec("DELETE t")],
    ]
    const done = runActiveTab("selection", { selectedText: "" })
    await waitForQuestion("stopped")
    expect(tab().results.map((r) => r.statement)).toEqual(["INSERT"])
    answerDeleteBackup(true)
    await done
    const [, second] = queries()
    expect(second.args?.sql).toBe(SCRIPT)
    expect(second.args?.options).toMatchObject({
      startAt: 1,
      resumeToken: "tok",
      deleteBackup: { skip: [1] },
    })
    expect(tab().results.map((r) => r.statement)).toEqual([
      "INSERT",
      "DELETE FROM big WHERE id > 0",
      "DELETE t",
    ])
  })

  it("stops for good when the user declines to go on", async () => {
    responses = [
      [
        exec("INSERT"),
        {
          kind: "backup_stopped",
          statementIndex: 1,
          reason: "the disk is full",
          statement: "DELETE FROM big WHERE id > 0",
          elapsedMs: 0,
          resumeToken: "tok",
        },
      ],
    ]
    const done = runActiveTab("selection", { selectedText: "" })
    await waitForQuestion("stopped")
    answerDeleteBackup(false)
    await done
    expect(queries()).toHaveLength(1)
    expect(toasts()).toEqual([expect.stringMatching(/Stopped at statement 2/)])
    expect(calls.find((c) => c.command === "mysql_release_resume")?.args).toEqual({
      connectionId: "c1",
      token: "tok",
    })
    expect(tab().results).toHaveLength(1)
  })

  it("asks again at a second stop and skips both", async () => {
    responses = [
      [exec("INSERT"), stopAt(1, "tok")],
      [exec("DELETE FROM big WHERE id > 0"), stopAt(2, "tok2")],
      [exec("DELETE t")],
    ]
    const done = runActiveTab("selection", { selectedText: "" })
    await waitForQuestion("stopped")
    answerDeleteBackup(true)
    await flush()
    await waitForQuestion("stopped")
    answerDeleteBackup(true)
    await done
    expect(queries()[2].args?.options).toMatchObject({
      startAt: 2,
      resumeToken: "tok2",
      deleteBackup: { skip: [1, 2] },
    })
    expect(tab().results).toHaveLength(3)
  })

  it("does not continue when the tab closed meanwhile, and frees the kept connection", async () => {
    responses = [[exec("INSERT"), stopAt(1, "tok")]]
    const done = runActiveTab("selection", { selectedText: "" })
    await waitForQuestion("stopped")
    useTabsStore.getState().close(tab().id)
    answerDeleteBackup(true)
    await done
    expect(queries()).toHaveLength(1)
    expect(calls.some((c) => c.command === "mysql_release_resume")).toBe(true)
    expect(toasts()).toEqual([])
  })

  it("keeps the earlier results when continuing fails", async () => {
    responses = [[exec("INSERT"), stopAt(1, "tok")], "fail"]
    const done = runActiveTab("selection", { selectedText: "" })
    await waitForQuestion("stopped")
    answerDeleteBackup(true)
    await done
    expect(tab().results.map((r) => r.statement)).toEqual(["INSERT"])
    expect(tab().error?.message).toMatch(/from the start/)
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      tone: "error",
      message: "The script couldn't continue from statement 2",
      detail: "Run the script again from the start.",
    })
  })

  it("runs nothing when the DELETE check fails", async () => {
    restore()
    restore = setTransport(async (command) => {
      calls.push({ command })
      if (command === "mysql_delete_plan") throw { kind: "unknown", message: "ipc down" }
      return []
    })
    await runActiveTab("selection", { selectedText: "" })
    expect(queries()).toHaveLength(0)
    expect(toasts()).toEqual([expect.stringMatching(/Couldn't check the DELETE statements/)])
  })

  it("never asks the backend about scripts without DELETE", async () => {
    useTabsStore.getState().setSql(tab().id, "UPDATE t SET deleted_at = NOW() WHERE id = 1")
    responses = [[exec("UPDATE")]]
    await runActiveTab("selection", { selectedText: "" })
    expect(calls.map((c) => c.command)).toEqual(["mysql_query"])
  })
})

describe("appendRun", () => {
  it("adds a continued run's results after the earlier ones", () => {
    const base = {
      ...createTab("t", "c1", "Query 1", "app"),
      lastElapsedMs: 3,
    }
    const first = { ...base, results: [exec("A")] }
    const next = appendRun(first, "A; B", [exec("B", { elapsedMs: 4 })], "app")
    expect(next.results.map((r) => r.statement)).toEqual(["A", "B"])
    expect(next.lastElapsedMs).toBe(7)
    expect(next.ranDatabase).toBe("app")
  })
})
