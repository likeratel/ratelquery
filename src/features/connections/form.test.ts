import { describe, expect, it } from "vitest"
import type { ConnectionConfig } from "../../lib/connections"
import { emptyForm, formFromConfig, mysqlFormSchema, parseForm, type ConnectionForm } from "./form"

const NEW = { hasStoredSecret: false }

function mysqlForm(patch: Partial<ConnectionForm["mysql"]> = {}): ConnectionForm {
  const base = emptyForm("mysql")
  return { ...base, mysql: { ...base.mysql, name: "Local", user: "root", ...patch } }
}

function dynamoForm(patch: Partial<ConnectionForm["dynamodb"]> = {}): ConnectionForm {
  const base = emptyForm("dynamodb")
  return { ...base, dynamodb: { ...base.dynamodb, name: "Dynamo", ...patch } }
}

describe("mysqlFormSchema", () => {
  it("reports required fields with readable messages", () => {
    const result = mysqlFormSchema.safeParse({ ...emptyForm().mysql, host: " " })
    expect(result.success).toBe(false)
    const messages = result.error?.issues.map((i) => i.message) ?? []
    expect(messages).toContain("Name is required")
    expect(messages).toContain("Host is required")
    expect(messages).toContain("User is required")
  })

  it.each([
    ["", "Port is required"],
    ["abc", "Port must be a number"],
    ["0", "Port must be 1 to 65535"],
    ["70000", "Port must be 1 to 65535"],
  ])("rejects port %j", (port, message) => {
    const result = parseForm(mysqlForm({ port }), NEW)
    expect(result).toEqual({ ok: false, errors: { port: message } })
  })
})

describe("parseForm for MySQL", () => {
  it("builds a config without undefined keys and a null secret when password is blank", () => {
    const result = parseForm(mysqlForm({ host: " db.local ", port: "3307" }), NEW)
    expect(result).toEqual({
      ok: true,
      config: { kind: "mysql", id: "", name: "Local", host: "db.local", port: 3307, user: "root" },
      secret: null,
    })
    if (result.ok) expect(Object.keys(result.config)).not.toContain("database")
  })

  it("passes the password as the secret and keeps the edited id", () => {
    const original: ConnectionConfig = {
      kind: "mysql",
      id: "abc",
      name: "Old",
      host: "h",
      port: 3306,
      user: "u",
    }
    const result = parseForm(mysqlForm({ password: " p w ", database: "app", color: "#7c9cff" }), {
      original,
      hasStoredSecret: true,
    })
    expect(result.ok && result.config).toMatchObject({
      id: "abc",
      database: "app",
      color: "#7c9cff",
    })
    expect(result.ok && result.secret).toBe(" p w ")
  })

  it("rejects colors outside the hex format", () => {
    expect(parseForm(mysqlForm({ color: "red" }), NEW)).toEqual({
      ok: false,
      errors: { color: "Pick one of the colors" },
    })
  })
})

describe("parseForm for DynamoDB", () => {
  it("builds a profile config", () => {
    const result = parseForm(dynamoForm({ endpoint: "http://localhost:8000" }), NEW)
    expect(result).toEqual({
      ok: true,
      config: {
        kind: "dynamodb",
        id: "",
        name: "Dynamo",
        region: "ap-northeast-2",
        endpoint: "http://localhost:8000",
        auth: { type: "profile", profile: "default" },
      },
      secret: null,
    })
  })

  it("validates endpoint, region and profile", () => {
    const result = parseForm(
      dynamoForm({ endpoint: "localhost:8000", region: "", profile: "" }),
      NEW,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["endpoint", "profile", "region"])
    }
  })

  it("requires a secret for new access key connections", () => {
    const result = parseForm(dynamoForm({ authType: "keys", accessKeyId: "AKIA" }), NEW)
    expect(result).toEqual({
      ok: false,
      errors: { secretAccessKey: "Secret access key is required" },
    })
  })

  it("allows a blank secret when editing keys with a stored secret", () => {
    const original: ConnectionConfig = {
      kind: "dynamodb",
      id: "d1",
      name: "Dynamo",
      region: "us-east-1",
      auth: { type: "keys", accessKeyId: "AKIA" },
    }
    const result = parseForm(formFromConfig(original), { original, hasStoredSecret: true })
    expect(result).toEqual({ ok: true, config: original, secret: null })
  })

  it("clears the stored secret when switching from keys to a profile", () => {
    const original: ConnectionConfig = {
      kind: "dynamodb",
      id: "d1",
      name: "Dynamo",
      region: "us-east-1",
      auth: { type: "keys", accessKeyId: "AKIA" },
    }
    const form = formFromConfig(original)
    const switched = {
      ...form,
      dynamodb: { ...form.dynamodb, authType: "profile" as const, profile: "dev" },
    }
    const result = parseForm(switched, { original, hasStoredSecret: true })
    expect(result.ok && result.secret).toBe("")
    expect(result.ok && result.config).toMatchObject({ auth: { type: "profile", profile: "dev" } })
  })
})

describe("formFromConfig", () => {
  it("round-trips a MySQL config without exposing secrets", () => {
    const config: ConnectionConfig = {
      kind: "mysql",
      id: "m1",
      name: "Prod",
      host: "db",
      port: 3306,
      user: "app",
      database: "shop",
      color: "#4fd1a1",
    }
    const form = formFromConfig(config)
    expect(form.mysql.password).toBe("")
    expect(parseForm(form, { original: config, hasStoredSecret: true })).toEqual({
      ok: true,
      config,
      secret: null,
    })
  })
})
