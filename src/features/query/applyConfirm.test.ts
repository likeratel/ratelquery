import { afterEach, describe, expect, it } from "vitest"
import {
  answerApplyConfirm,
  confirmApply,
  confirmApplyWithoutBackup,
  useApplyConfirmStore,
  type ApplyRequest,
} from "./applyConfirm"

const request: ApplyRequest = {
  table: "app.users",
  counts: { updates: 1, deletes: 1, inserts: 0 },
  retentionDays: 30,
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => answerApplyConfirm(false))

describe("confirmApply", () => {
  it("shows loading, then the preview, and resolves with the answer", async () => {
    const answer = confirmApply(request, async () => ({ statements: ["DELETE 1"], warning: null }))
    expect(useApplyConfirmStore.getState().pending).toMatchObject({
      kind: "apply",
      preview: { status: "loading" },
    })
    await flush()
    expect(useApplyConfirmStore.getState().pending).toMatchObject({
      preview: { status: "ready", statements: ["DELETE 1"], warning: null },
    })
    answerApplyConfirm(true)
    await expect(answer).resolves.toBe(true)
    expect(useApplyConfirmStore.getState().pending).toBeNull()
  })

  it("ignores Apply until the preview has loaded", async () => {
    let finish: (value: { statements: string[]; warning: string | null }) => void = () => {}
    const answer = confirmApply(request, () => new Promise((resolve) => (finish = resolve)))
    answerApplyConfirm(true)
    expect(useApplyConfirmStore.getState().pending).toMatchObject({
      preview: { status: "loading" },
    })
    finish({ statements: [], warning: "unsafe charset" })
    await flush()
    answerApplyConfirm(true)
    await expect(answer).resolves.toBe(true)
  })

  it("lets Cancel through while the preview loads", async () => {
    const answer = confirmApply(request, () => new Promise(() => {}))
    answerApplyConfirm(false)
    await expect(answer).resolves.toBe(false)
  })

  it("shows a failed preview and still lets the user answer", async () => {
    const answer = confirmApply(request, () =>
      Promise.reject({ kind: "connection", message: "gone" }),
    )
    await flush()
    expect(useApplyConfirmStore.getState().pending).toMatchObject({
      preview: { status: "error", message: "gone" },
    })
    answerApplyConfirm(false)
    await expect(answer).resolves.toBe(false)
  })

  it("never lets a late preview reach a newer dialog", async () => {
    let finish: (value: { statements: string[]; warning: null }) => void = () => {}
    const first = confirmApply(request, () => new Promise((resolve) => (finish = resolve)))
    const second = confirmApplyWithoutBackup({ table: "app.users", message: "disk", deletes: 1 })
    await expect(first).resolves.toBe(false)
    finish({ statements: ["late"], warning: null })
    await flush()
    expect(useApplyConfirmStore.getState().pending).toMatchObject({ kind: "backup-failed" })
    answerApplyConfirm(true)
    await expect(second).resolves.toBe(true)
  })
})
