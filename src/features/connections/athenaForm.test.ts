import { describe, expect, it } from "vitest"
import type { AthenaConnectionConfig } from "../../lib/connections"
import { secretFingerprint, workgroupOptions, workgroupRequest } from "./athenaWorkgroups"
import { connectionSubtitle } from "./filter"
import {
  ATHENA_SECRET_AGAIN,
  emptyForm,
  formFromConfig,
  isFormChanged,
  OUTPUT_LOCATION_FORMAT,
  parseForm,
  type ConnectionForm,
} from "./form"

const NEW = { hasStoredSecret: false }

function athenaForm(patch: Partial<ConnectionForm["athena"]> = {}): ConnectionForm {
  const base = emptyForm("athena")
  return { ...base, athena: { ...base.athena, name: "Lake", profile: "default", ...patch } }
}

const keysConfig: AthenaConnectionConfig = {
  kind: "athena",
  id: "a1",
  name: "Lake",
  region: "us-east-1",
  auth: { type: "keys", accessKeyId: "AKIA" },
}

describe("parseForm for Athena", () => {
  it("builds a minimal profile config; the primary workgroup is left out", () => {
    expect(parseForm(athenaForm(), NEW)).toEqual({
      ok: true,
      config: {
        kind: "athena",
        id: "",
        name: "Lake",
        region: "ap-northeast-2",
        auth: { type: "profile", profile: "default" },
      },
      secret: null,
    })
  })

  it("keeps a custom workgroup, output location, database and color", () => {
    const form = athenaForm({
      workgroup: " analysts ",
      outputLocation: "s3://my-results/athena/",
      database: "sales",
      color: "#4fd1a1",
    })
    const result = parseForm(form, NEW)
    expect(result.ok && result.config).toEqual({
      kind: "athena",
      id: "",
      name: "Lake",
      region: "ap-northeast-2",
      auth: { type: "profile", profile: "default" },
      workgroup: "analysts",
      outputLocation: "s3://my-results/athena/",
      database: "sales",
      color: "#4fd1a1",
    })
  })

  it.each(["my-bucket", "s3://", "s3://ab", "s3://Upper/x", "https://bucket/x", "s3://b b/x"])(
    "rejects the output location %s",
    (outputLocation) => {
      const result = parseForm(athenaForm({ outputLocation }), NEW)
      expect(result).toEqual({ ok: false, errors: { outputLocation: OUTPUT_LOCATION_FORMAT } })
    },
  )

  it.each(["s3://my.bucket-1", "s3://bucket/prefix", "s3://bucket/a/b/"])(
    "accepts the output location %s",
    (outputLocation) => {
      expect(parseForm(athenaForm({ outputLocation }), NEW).ok).toBe(true)
    },
  )

  it("validates name, region, workgroup and profile", () => {
    const result = parseForm(
      athenaForm({ name: " ", region: "US East", workgroup: "", profile: "" }),
      NEW,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["name", "profile", "region", "workgroup"])
    }
  })

  it("requires a secret for new access key connections", () => {
    const result = parseForm(athenaForm({ authType: "keys", accessKeyId: "AKIA" }), NEW)
    expect(result).toEqual({
      ok: false,
      errors: { secretAccessKey: "Secret access key is required" },
    })
  })

  it("keeps a stored secret when editing keys without typing one", () => {
    const result = parseForm(formFromConfig(keysConfig), {
      original: keysConfig,
      hasStoredSecret: true,
    })
    expect(result).toEqual({ ok: true, config: keysConfig, secret: null })
  })

  it("clears the stored secret when switching from keys to a profile", () => {
    const form = formFromConfig(keysConfig)
    const switched = {
      ...form,
      athena: { ...form.athena, authType: "profile" as const, profile: "dev" },
    }
    const result = parseForm(switched, { original: keysConfig, hasStoredSecret: true })
    expect(result.ok && result.secret).toBe("")
  })
})

describe("re-entering the Athena secret", () => {
  const stored = { original: keysConfig, hasStoredSecret: true }

  it.each([
    ["region", { region: "eu-west-1" }],
    ["access key ID", { accessKeyId: "AKIB" }],
  ])("asks for the secret when the %s changes", (_field, patch) => {
    const form = formFromConfig(keysConfig)
    const moved = { ...form, athena: { ...form.athena, ...patch } }
    expect(parseForm(moved, stored)).toEqual({
      ok: false,
      errors: { secretAccessKey: ATHENA_SECRET_AGAIN },
    })
  })

  it("doesn't ask when only workgroup, output location or database change", () => {
    const form = formFromConfig(keysConfig)
    const edited = {
      ...form,
      athena: {
        ...form.athena,
        workgroup: "etl",
        outputLocation: "s3://other-bucket/",
        database: "raw",
      },
    }
    expect(parseForm(edited, stored).ok).toBe(true)
  })
})

describe("Athena form round trip", () => {
  it("restores every saved field and never prefills the secret", () => {
    const config: AthenaConnectionConfig = {
      ...keysConfig,
      workgroup: "etl",
      outputLocation: "s3://results/",
      database: "raw",
      color: "#7c9cff",
    }
    const form = formFromConfig(config)
    expect(form.kind).toBe("athena")
    expect(form.athena).toMatchObject({
      workgroup: "etl",
      outputLocation: "s3://results/",
      database: "raw",
      secretAccessKey: "",
    })
    expect(parseForm(form, { original: config, hasStoredSecret: true })).toEqual({
      ok: true,
      config,
      secret: null,
    })
  })

  it("shows primary for a config without a workgroup", () => {
    expect(formFromConfig(keysConfig).athena.workgroup).toBe("primary")
  })

  it("counts Athena field changes", () => {
    const initial = athenaForm()
    expect(isFormChanged(initial, { ...initial })).toBe(false)
    expect(isFormChanged(initial, athenaForm({ workgroup: "etl" }))).toBe(true)
  })
})

describe("workgroupRequest", () => {
  it("waits for a region and a profile", () => {
    expect(workgroupRequest(athenaForm({ profile: "" }).athena, NEW)).toBeNull()
    expect(workgroupRequest(athenaForm({ region: "" }).athena, NEW)).toBeNull()
    const request = workgroupRequest(athenaForm().athena, NEW)
    expect(request?.config).toMatchObject({
      kind: "athena",
      region: "ap-northeast-2",
      auth: { type: "profile", profile: "default" },
    })
    expect(request?.secret).toBeNull()
  })

  it("needs a typed secret for new access keys, once its field lost focus", () => {
    const draft = athenaForm({ authType: "keys", accessKeyId: "AKIA" }).athena
    expect(workgroupRequest(draft, NEW)).toBeNull()
    const typed = { ...draft, secretAccessKey: "s3cr3t" }
    // Still typing: nothing is sent.
    expect(workgroupRequest(typed, NEW)).toBeNull()
    expect(workgroupRequest(typed, NEW, secretFingerprint("s3cr"))).toBeNull()
    const request = workgroupRequest(typed, NEW, secretFingerprint("s3cr3t"))
    expect(request?.secret).toBe("s3cr3t")
    expect(request?.key).not.toContain("s3cr3t")
    // Typing again after the blur stops the listing until the next blur.
    const committed = secretFingerprint("s3cr3t")
    expect(workgroupRequest({ ...typed, secretAccessKey: "s3cr3tX" }, NEW, committed)).toBeNull()
  })

  it("fingerprints a secret by length and hash, not by its text", () => {
    expect(secretFingerprint("abc")).toBe(secretFingerprint("abc"))
    expect(secretFingerprint("abc")).not.toBe(secretFingerprint("abd"))
    expect(secretFingerprint("abc")).toMatch(/^3:[0-9a-f]+$/)
    expect(secretFingerprint("abc")).not.toContain("abc")
  })

  it("reuses a stored secret only for the saved region and key", () => {
    const stored = { original: keysConfig, hasStoredSecret: true }
    const draft = formFromConfig(keysConfig).athena
    expect(workgroupRequest(draft, stored)).toMatchObject({ secret: null, config: { id: "a1" } })
    expect(workgroupRequest({ ...draft, region: "eu-west-1" }, stored)).toBeNull()
  })

  it("changes its key when the answer could change", () => {
    const a = workgroupRequest(athenaForm().athena, NEW)
    const b = workgroupRequest(athenaForm({ profile: "dev" }).athena, NEW)
    const renamed = workgroupRequest(athenaForm({ name: "Other" }).athena, NEW)
    expect(a?.key).not.toBe(b?.key)
    expect(a?.key).toBe(renamed?.key)
  })
})

describe("workgroupOptions", () => {
  it("adds the current workgroup when the list lacks it", () => {
    expect(workgroupOptions(["primary", "etl"], "etl")).toEqual(["primary", "etl"])
    expect(workgroupOptions(["primary"], "gone")).toEqual(["gone", "primary"])
    expect(workgroupOptions(["primary"], "")).toEqual(["primary"])
  })
})

describe("Athena subtitle", () => {
  it("shows region and workgroup", () => {
    expect(connectionSubtitle(keysConfig)).toBe("us-east-1 · primary")
    expect(connectionSubtitle({ ...keysConfig, workgroup: "etl" })).toBe("us-east-1 · etl")
  })
})
