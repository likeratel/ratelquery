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
  KEY_PATH_ABSOLUTE,
  SSH_NO_VERIFY_IDENTITY,
  MYSQL_SECRET_AGAIN,
  SSH_PASSWORD_AGAIN,
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

describe("SSH tunnel", () => {
  const tunnel = (patch: Partial<ConnectionForm["mysql"]> = {}) =>
    mysqlForm({
      host: "10.0.0.5",
      sshEnabled: true,
      sshHost: " bastion.example.com ",
      sshUser: "ec2-user",
      ...patch,
    })

  it("leaves ssh and the SSH secret out when the toggle is off", () => {
    const result = parseForm(mysqlForm({ sshHost: "ignored", sshSecret: "pw" }), NEW)
    expect(result).toEqual({
      ok: true,
      config: { kind: "mysql", id: "", name: "Local", host: "localhost", port: 3306, user: "root" },
      secret: null,
    })
    if (result.ok) expect(Object.keys(result)).not.toContain("sshSecret")
  })

  it("sends agent auth with the default port and no SSH secret", () => {
    const result = parseForm(tunnel(), NEW)
    expect(result).toEqual({
      ok: true,
      config: {
        kind: "mysql",
        id: "",
        name: "Local",
        host: "10.0.0.5",
        port: 3306,
        user: "root",
        ssh: { host: "bastion.example.com", port: 22, user: "ec2-user", auth: { type: "agent" } },
      },
      secret: null,
    })
  })

  it("sends the key path and the passphrase as the SSH secret", () => {
    const result = parseForm(
      tunnel({ sshAuth: "key", sshKeyPath: "/Users/me/.ssh/id_ed25519", sshSecret: "phrase" }),
      NEW,
    )
    expect(result).toMatchObject({
      ok: true,
      config: { ssh: { auth: { type: "key", keyPath: "/Users/me/.ssh/id_ed25519" } } },
      sshSecret: "phrase",
    })
  })

  it("sends password auth and keeps a blank SSH password as null", () => {
    const typed = parseForm(tunnel({ sshAuth: "password", sshSecret: "pw", sshPort: "2222" }), NEW)
    expect(typed).toMatchObject({
      ok: true,
      config: { ssh: { port: 2222, auth: { type: "password" } } },
      sshSecret: "pw",
    })
    expect(parseForm(tunnel({ sshAuth: "password" }), NEW)).toMatchObject({ sshSecret: null })
  })

  it("validates the SSH fields only while the toggle is on", () => {
    const result = parseForm(
      tunnel({ sshHost: " ", sshUser: "", sshPort: "0", sshAuth: "key", sshKeyPath: "" }),
      NEW,
    )
    expect(result).toEqual({
      ok: false,
      errors: {
        sshHost: "SSH host is required",
        sshUser: "SSH user is required",
        sshPort: "Port must be 1 to 65535",
        sshKeyPath: "Key file is required",
      },
    })
    const off = mysqlForm({ sshHost: " ", sshPort: "x" })
    expect(parseForm(off, NEW).ok).toBe(true)
  })

  it("requires an absolute key path", () => {
    for (const sshKeyPath of ["~/.ssh/id_rsa", "id_rsa", ".ssh/id_rsa"]) {
      expect(parseForm(tunnel({ sshAuth: "key", sshKeyPath }), NEW)).toEqual({
        ok: false,
        errors: { sshKeyPath: KEY_PATH_ABSOLUTE },
      })
    }
    for (const sshKeyPath of ["/home/me/.ssh/id_rsa", "C:\\Users\\me\\id_rsa"]) {
      expect(parseForm(tunnel({ sshAuth: "key", sshKeyPath }), NEW).ok).toBe(true)
    }
  })

  it("refuses identity verification through a tunnel but allows the other TLS modes", () => {
    expect(parseForm(tunnel({ tls: "verify_identity" }), NEW)).toEqual({
      ok: false,
      errors: { tls: `Verify identity: ${SSH_NO_VERIFY_IDENTITY}` },
    })
    expect(parseForm(tunnel({ tls: "verify_ca" }), NEW).ok).toBe(true)
    expect(parseForm(mysqlForm({ tls: "verify_identity" }), NEW).ok).toBe(true)
  })

  it("reports MySQL and SSH errors together", () => {
    const result = parseForm(tunnel({ name: "", sshHost: "" }), NEW)
    expect(result).toEqual({
      ok: false,
      errors: { name: "Name is required", sshHost: "SSH host is required" },
    })
  })

  const viaKey: ConnectionConfig = {
    kind: "mysql",
    id: "m1",
    name: "Prod",
    host: "10.0.0.5",
    port: 3306,
    user: "app",
    ssh: {
      host: "bastion",
      port: 22,
      user: "ops",
      auth: { type: "key", keyPath: "/k/id_ed25519" },
    },
  }

  it("round-trips the SSH settings through the form without the secret", () => {
    const form = formFromConfig(viaKey)
    expect(form.mysql).toMatchObject({
      sshEnabled: true,
      sshHost: "bastion",
      sshPort: "22",
      sshUser: "ops",
      sshAuth: "key",
      sshKeyPath: "/k/id_ed25519",
      sshSecret: "",
    })
    const context = { original: viaKey, hasStoredSecret: true, hasStoredSshSecret: true }
    expect(parseForm(form, context)).toEqual({
      ok: true,
      config: viaKey,
      secret: null,
      sshSecret: null,
    })
    expect(isFormChanged(form, form)).toBe(false)
    const toggled = { ...form, mysql: { ...form.mysql, sshEnabled: false } }
    expect(isFormChanged(form, toggled)).toBe(true)
  })

  it("clears the stored SSH secret when SSH is turned off or switched to the agent", () => {
    const form = formFromConfig(viaKey)
    const context = { original: viaKey, hasStoredSecret: false, hasStoredSshSecret: true }
    const off = { ...form, mysql: { ...form.mysql, sshEnabled: false } }
    expect(parseForm(off, context)).toMatchObject({ ok: true, sshSecret: "" })
    const agent = { ...form, mysql: { ...form.mysql, sshAuth: "agent" as const } }
    expect(parseForm(agent, context)).toMatchObject({ ok: true, sshSecret: "" })
  })

  it("clears a kept passphrase when the key file or bastion changes", () => {
    const form = formFromConfig(viaKey)
    const context = { original: viaKey, hasStoredSecret: false, hasStoredSshSecret: true }
    const newKey = { ...form, mysql: { ...form.mysql, sshKeyPath: "/k/other" } }
    expect(parseForm(newKey, context)).toMatchObject({ ok: true, sshSecret: "" })
  })

  it("asks for the database password again when the tunnel changes", () => {
    const form = formFromConfig(viaKey)
    const context = { original: viaKey, hasStoredSecret: true, hasStoredSshSecret: false }
    for (const patch of [
      { sshEnabled: false },
      { sshHost: "other-bastion" },
      { sshPort: "2222" },
      { sshUser: "root" },
    ]) {
      const moved = { ...form, mysql: { ...form.mysql, ...patch } }
      expect(parseForm(moved, context)).toEqual({
        ok: false,
        errors: { password: MYSQL_SECRET_AGAIN },
      })
    }
    const sameBastion = { ...form, mysql: { ...form.mysql, sshHost: "BASTION" } }
    expect(parseForm(sameBastion, context).ok).toBe(true)
    const plain: ConnectionConfig = { ...viaKey, ssh: undefined }
    const turnedOn = formFromConfig(viaKey)
    expect(parseForm(turnedOn, { original: plain, hasStoredSecret: true })).toEqual({
      ok: false,
      errors: { password: MYSQL_SECRET_AGAIN },
    })
  })

  it("asks for the SSH password again when the bastion, user or auth changes", () => {
    const viaPassword: ConnectionConfig = {
      ...viaKey,
      ssh: { host: "bastion", port: 22, user: "ops", auth: { type: "password" } },
    }
    const form = formFromConfig(viaPassword)
    const context = { original: viaPassword, hasStoredSecret: false, hasStoredSshSecret: true }
    const moved = { ...form, mysql: { ...form.mysql, sshUser: "root" } }
    expect(parseForm(moved, context)).toEqual({
      ok: false,
      errors: { sshSecret: SSH_PASSWORD_AGAIN },
    })
    const retyped = { ...form, mysql: { ...form.mysql, sshUser: "root", sshSecret: "pw" } }
    expect(parseForm(retyped, context)).toMatchObject({ ok: true, sshSecret: "pw" })
    const fromKey = formFromConfig(viaKey)
    const switched = { ...fromKey, mysql: { ...fromKey.mysql, sshAuth: "password" as const } }
    expect(
      parseForm(switched, { original: viaKey, hasStoredSecret: false, hasStoredSshSecret: true }),
    ).toEqual({ ok: false, errors: { sshSecret: SSH_PASSWORD_AGAIN } })
    const renamed = { ...form, mysql: { ...form.mysql, name: "Renamed" } }
    expect(parseForm(renamed, context)).toMatchObject({ ok: true, sshSecret: null })
  })
})
