import { describe, expect, it } from "vitest"
import { dynamoErrorHint } from "./errors"

describe("dynamoErrorHint", () => {
  it("tells key connections to enter the secret key on credential errors", () => {
    expect(dynamoErrorHint("credential", "keys")).toContain(
      "Edit the connection to enter the secret key",
    )
    expect(dynamoErrorHint("credential", "profile")).toContain("aws sso login")
    expect(dynamoErrorHint("connection", "keys")).toBe(dynamoErrorHint("connection"))
  })
})
