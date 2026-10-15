import { afterEach, describe, expect, it } from "vitest"
import { requestHostKeyTrust, resetHostKeyPrompt, useHostKeyPrompt } from "./hostKeyPrompt"

const MESSAGE =
  "ssh-ed25519 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s is the host key of h:22.\nh ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq"
const queue = () => useHostKeyPrompt.getState().queue

afterEach(() => resetHostKeyPrompt())

describe("requestHostKeyTrust", () => {
  it("queues the parsed key and resolves with the decision", async () => {
    const pending = requestHostKeyTrust({ host: "bastion", port: 22 }, MESSAGE)
    expect(queue()).toHaveLength(1)
    expect(queue()[0]).toMatchObject({
      target: { host: "bastion", port: 22 },
      message: MESSAGE,
      details: { keyType: "ssh-ed25519", changed: false },
    })
    useHostKeyPrompt.getState().answer(queue()[0].id, true)
    await expect(pending).resolves.toBe(true)
    expect(queue()).toEqual([])
  })

  it("shares one prompt per server and queues other servers behind it", async () => {
    const first = requestHostKeyTrust({ host: "Bastion", port: 22 }, MESSAGE)
    const again = requestHostKeyTrust({ host: "bastion", port: 22 }, MESSAGE)
    const otherPort = requestHostKeyTrust({ host: "bastion", port: 2222 }, MESSAGE)
    expect(again).toBe(first)
    expect(queue().map((r) => r.target.port)).toEqual([22, 2222])
    const [a, b] = queue()
    useHostKeyPrompt.getState().answer(a.id, false)
    useHostKeyPrompt.getState().answer(b.id, true)
    await expect(first).resolves.toBe(false)
    await expect(otherPort).resolves.toBe(true)
  })

  it("keeps an unreadable message without details", () => {
    void requestHostKeyTrust({ host: "h", port: 22 }, "host key rejected")
    expect(queue()[0].details).toBeNull()
  })

  it("declines open requests on reset and ignores late answers", async () => {
    const pending = requestHostKeyTrust({ host: "h", port: 22 }, MESSAGE)
    const { id } = queue()[0]
    resetHostKeyPrompt()
    useHostKeyPrompt.getState().answer(id, true)
    await expect(pending).resolves.toBe(false)
    expect(queue()).toEqual([])
  })
})
