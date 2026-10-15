import { describe, expect, it } from "vitest"
import type { ConnectionConfig } from "../../lib/connections"
import {
  DYNAMO_SECRET_AGAIN,
  emptyForm,
  ENDPOINT_FULL_URL,
  ENDPOINT_NO_FRAGMENT,
  ENDPOINT_NO_USERINFO,
  endpointProblem,
  formFromConfig,
  insecureEndpointWarning,
  isFormChanged,
  MYSQL_SECRET_AGAIN,
  mysqlFormSchema,
  parseForm,
  type ConnectionForm,
} from "./form"

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

describe("TLS settings", () => {
  it("defaults to preferred and leaves it out of the payload", () => {
    expect(emptyForm().mysql.tls).toBe("preferred")
    const result = parseForm(mysqlForm({ caCertPath: "/ca.pem" }), NEW)
    expect(result.ok && Object.keys(result.config)).not.toContain("tls")
    expect(result.ok && Object.keys(result.config)).not.toContain("caCertPath")
  })

  it("sends the mode, and the CA path only for the verify modes", () => {
    const required = parseForm(mysqlForm({ tls: "required", caCertPath: "/ca.pem" }), NEW)
    expect(required.ok && required.config).toMatchObject({ tls: "required" })
    expect(required.ok && Object.keys(required.config)).not.toContain("caCertPath")
    const verify = parseForm(mysqlForm({ tls: "verify_ca", caCertPath: " /etc/ca.pem " }), NEW)
    expect(verify.ok && verify.config).toMatchObject({
      tls: "verify_ca",
      caCertPath: "/etc/ca.pem",
    })
    const noCa = parseForm(mysqlForm({ tls: "verify_identity" }), NEW)
    expect(noCa.ok && Object.keys(noCa.config)).not.toContain("caCertPath")
  })

  it("round-trips TLS settings through the form", () => {
    const config: ConnectionConfig = {
      kind: "mysql",
      id: "m1",
      name: "Prod",
      host: "db",
      port: 3306,
      user: "app",
      tls: "verify_identity",
      caCertPath: "/ca.pem",
    }
    const form = formFromConfig(config)
    expect(form.mysql).toMatchObject({ tls: "verify_identity", caCertPath: "/ca.pem" })
    expect(parseForm(form, { original: config, hasStoredSecret: true })).toEqual({
      ok: true,
      config,
      secret: null,
    })
  })

  it("rejects unknown modes", () => {
    const form = mysqlForm()
    const bad = { ...form, mysql: { ...form.mysql, tls: "off" as never } }
    expect(parseForm(bad, NEW).ok).toBe(false)
  })
})

describe("re-entering a secret for a new target", () => {
  const mysql: ConnectionConfig = {
    kind: "mysql",
    id: "m1",
    name: "Prod",
    host: "db",
    port: 3306,
    user: "app",
  }
  const stored = { original: mysql, hasStoredSecret: true }

  it.each([
    ["host", { host: "evil.example" }],
    ["port", { port: "3307" }],
    ["user", { user: "root" }],
    ["TLS mode", { tls: "required" as const }],
    ["CA certificate", { tls: "verify_ca" as const, caCertPath: "/other.pem" }],
  ])("asks for the password when the %s changes", (_field, patch) => {
    const form = formFromConfig(mysql)
    const moved = { ...form, mysql: { ...form.mysql, ...patch } }
    expect(parseForm(moved, stored)).toEqual({
      ok: false,
      errors: { password: MYSQL_SECRET_AGAIN },
    })
  })

  it("allows the change with a new password, or when nothing is stored", () => {
    const form = formFromConfig(mysql)
    const moved = { ...form, mysql: { ...form.mysql, host: "db2", password: "pw" } }
    expect(parseForm(moved, stored).ok).toBe(true)
    const blank = { ...form, mysql: { ...form.mysql, host: "db2" } }
    expect(parseForm(blank, { original: mysql, hasStoredSecret: false }).ok).toBe(true)
  })

  it("keeps the stored password for edits that don't move the connection", () => {
    const form = formFromConfig(mysql)
    const renamed = { ...form, mysql: { ...form.mysql, name: "Renamed", host: " db " } }
    expect(parseForm(renamed, stored)).toMatchObject({ ok: true, secret: null })
    const upper = { ...form, mysql: { ...form.mysql, host: "DB" } }
    expect(parseForm(upper, stored)).toMatchObject({ ok: true, secret: null })
    const preferred = { ...form, mysql: { ...form.mysql, tls: "preferred" as const } }
    expect(parseForm(preferred, stored)).toMatchObject({ ok: true, secret: null })
  })

  it("asks for the secret access key when region, endpoint or key ID changes", () => {
    const dynamo: ConnectionConfig = {
      kind: "dynamodb",
      id: "d1",
      name: "Dynamo",
      region: "us-east-1",
      auth: { type: "keys", accessKeyId: "AKIA" },
    }
    const context = { original: dynamo, hasStoredSecret: true }
    const form = formFromConfig(dynamo)
    for (const patch of [
      { region: "eu-west-1" },
      { endpoint: "https://proxy.example" },
      { accessKeyId: "AKIB" },
    ]) {
      const moved = { ...form, dynamodb: { ...form.dynamodb, ...patch } }
      expect(parseForm(moved, context)).toEqual({
        ok: false,
        errors: { secretAccessKey: DYNAMO_SECRET_AGAIN },
      })
    }
    const withSecret = {
      ...form,
      dynamodb: { ...form.dynamodb, region: "eu-west-1", secretAccessKey: "s" },
    }
    expect(parseForm(withSecret, context).ok).toBe(true)
  })
})

describe("insecureEndpointWarning", () => {
  it.each([
    ["", false],
    ["http://localhost:8000", false],
    ["http://127.0.0.1:8000", false],
    ["http://[::1]:8000", false],
    ["https://dynamodb.example.com", false],
    ["http://dynamo.internal:8000", true],
    ["http://10.0.0.5:8000", true],
    ["http://localhost.example.com", true],
  ])("%j warns: %s", (endpoint, warns) => {
    expect(insecureEndpointWarning(endpoint) !== null).toBe(warns)
  })
})

describe("endpointProblem", () => {
  it.each([
    ["", null],
    ["http://localhost:8000", null],
    ["https://dynamodb.us-east-1.amazonaws.com/", null],
    ["localhost:8000", ENDPOINT_FULL_URL],
    ["ftp://example.com", ENDPOINT_FULL_URL],
    ["http://user:secret@localhost:8000", ENDPOINT_NO_USERINFO],
    ["http://user@localhost:8000", ENDPOINT_NO_USERINFO],
    ["http://@localhost:8000", ENDPOINT_NO_USERINFO],
    ["http://localhost:8000/#frag", ENDPOINT_NO_FRAGMENT],
    ["http://localhost:8000#", ENDPOINT_NO_FRAGMENT],
  ])("%j -> %s", (endpoint, problem) => {
    expect(endpointProblem(endpoint)).toBe(problem)
  })

  it("reports the problem on the endpoint field", () => {
    const result = parseForm(dynamoForm({ endpoint: "https://a:b@proxy.example" }), NEW)
    expect(result).toEqual({ ok: false, errors: { endpoint: ENDPOINT_NO_USERINFO } })
  })
})

describe("isFormChanged", () => {
  it("is false until a visible field or the kind changes", () => {
    const initial = mysqlForm()
    expect(isFormChanged(initial, { ...initial })).toBe(false)
    expect(isFormChanged(initial, mysqlForm({ host: "db" }))).toBe(true)
    expect(isFormChanged(initial, { ...initial, kind: "dynamodb" })).toBe(true)
  })

  it("ignores the hidden draft of the other kind", () => {
    const initial = mysqlForm()
    const hidden = { ...initial, dynamodb: { ...initial.dynamodb, name: "typed earlier" } }
    expect(isFormChanged(initial, hidden)).toBe(false)
  })
})
