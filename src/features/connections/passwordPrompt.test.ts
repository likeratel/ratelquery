import { afterEach, describe, expect, it } from "vitest"
import type { MysqlConnectionConfig } from "../../lib/connections"
import { requestPassword, resetPasswordPrompt, usePasswordPrompt } from "./passwordPrompt"

const config = (id: string): MysqlConnectionConfig => ({
  kind: "mysql",
  id,
  name: `db ${id}`,
  host: "localhost",
  port: 3306,
  user: "root",
})

const queue = () => usePasswordPrompt.getState().queue

afterEach(() => resetPasswordPrompt())

describe("requestPassword", () => {
  it("queues a request and resolves with the answer", async () => {
    const pending = requestPassword(config("a"))
    expect(queue()).toHaveLength(1)
    expect(queue()[0].config.id).toBe("a")
    usePasswordPrompt.getState().answer(queue()[0].id, { secret: "pw", remember: true })
    await expect(pending).resolves.toEqual({ secret: "pw", remember: true })
    expect(queue()).toEqual([])
  })

  it("resolves with null when cancelled", async () => {
    const pending = requestPassword(config("a"))
    usePasswordPrompt.getState().answer(queue()[0].id, null)
    await expect(pending).resolves.toBeNull()
    expect(queue()).toEqual([])
  })

  it("shares one prompt per connection and queues other connections behind it", async () => {
    const first = requestPassword(config("a"))
    const again = requestPassword(config("a"))
    const other = requestPassword(config("b"))
    expect(again).toBe(first)
    expect(queue().map((r) => r.config.id)).toEqual(["a", "b"])
    const [a, b] = queue()
    usePasswordPrompt.getState().answer(a.id, { secret: "x", remember: false })
    expect(queue().map((r) => r.config.id)).toEqual(["b"])
    usePasswordPrompt.getState().answer(b.id, null)
    await expect(first).resolves.toEqual({ secret: "x", remember: false })
    await expect(other).resolves.toBeNull()
  })

  it("ignores an answer for a request that is already settled", async () => {
    const pending = requestPassword(config("a"))
    const { id } = queue()[0]
    usePasswordPrompt.getState().answer(id, null)
    usePasswordPrompt.getState().answer(id, { secret: "late", remember: true })
    await expect(pending).resolves.toBeNull()
    // A new request after the old one settled opens a fresh prompt.
    void requestPassword(config("a"))
    expect(queue()).toHaveLength(1)
    expect(queue()[0].id).not.toBe(id)
  })
})
