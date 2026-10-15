import { describe, expect, it } from "vitest"
import type { AwsProfile } from "../../lib/connections"
import {
  manualTogglePatch,
  profileChoicePatch,
  profileInputMode,
  profileOptionLabel,
  type AwsProfilesState,
} from "./awsProfiles"
import { DEFAULT_REGION, emptyForm, formFromConfig, type DynamoDraft } from "./form"

const PROD: AwsProfile = { name: "prod", region: "eu-west-1", source: "config", sso: false }
const SSO: AwsProfile = { name: "sso-dev", region: null, source: "config", sso: true }
const DEV: AwsProfile = { name: "dev", region: "us-east-2", source: "both", sso: true }

const READY: AwsProfilesState = { status: "ready", profiles: [DEV, PROD, SSO] }
const EMPTY: AwsProfilesState = { status: "ready", profiles: [] }
const CREATING = { creating: true }

function draft(patch: Partial<DynamoDraft> = {}): DynamoDraft {
  return { ...emptyForm("dynamodb").dynamodb, ...patch }
}

const choose = (d: DynamoDraft, name: string, context = CREATING) => ({
  ...d,
  ...profileChoicePatch(d, name, READY, context),
})

describe("profileInputMode", () => {
  it("shows the list for a new connection without picking a profile", () => {
    expect(emptyForm("dynamodb").dynamodb.profile).toBe("")
    expect(profileInputMode(READY, "", null)).toBe("list")
    expect(profileInputMode(READY, "prod", null)).toBe("list")
  })

  it("falls back to a text input when loading failed or found nothing", () => {
    expect(profileInputMode({ status: "failed" }, "", null)).toBe("fallback")
    expect(profileInputMode(EMPTY, "", true)).toBe("fallback")
    expect(profileInputMode({ status: "loading" }, "", null)).toBe("loading")
  })

  it("opens a saved profile that is not listed in manual mode", () => {
    expect(profileInputMode(READY, "gone", null)).toBe("manual")
  })

  it("follows the user's toggle", () => {
    expect(profileInputMode(READY, "prod", true)).toBe("manual")
    expect(profileInputMode(READY, "gone", false)).toBe("list")
  })
})

describe("profileChoicePatch", () => {
  it("fills the default region and a blank name from the chosen profile", () => {
    expect(profileChoicePatch(draft(), "prod", READY, CREATING)).toEqual({
      profile: "prod",
      region: "eu-west-1",
      name: "prod",
    })
  })

  it("keeps a region and name the user typed", () => {
    const typed = draft({ name: "Orders", region: "ap-south-1" })
    expect(profileChoicePatch(typed, "prod", READY, CREATING)).toEqual({ profile: "prod" })
  })

  it("replaces what the previous choice filled in", () => {
    const next = choose(choose(draft(), "prod"), "dev")
    expect(next).toMatchObject({ profile: "dev", region: "us-east-2", name: "dev" })
  })

  it("leaves the region alone when the profile has none", () => {
    const next = choose(draft(), "sso-dev")
    expect(next).toMatchObject({ profile: "sso-dev", region: DEFAULT_REGION, name: "sso-dev" })
  })

  it("treats a saved connection's region as the user's own", () => {
    const saved = formFromConfig({
      kind: "dynamodb",
      id: "1",
      name: "Saved",
      region: DEFAULT_REGION,
      auth: { type: "profile", profile: "gone" },
    }).dynamodb
    expect(profileChoicePatch(saved, "prod", READY, { creating: false })).toEqual({
      profile: "prod",
    })
  })
})

describe("profileOptionLabel", () => {
  it("names the region and SSO", () => {
    expect(profileOptionLabel(DEV)).toBe("dev (us-east-2, SSO)")
    expect(profileOptionLabel(PROD)).toBe("prod (eu-west-1)")
    expect(profileOptionLabel(SSO)).toBe("sso-dev (no region, SSO)")
  })
})

describe("manualTogglePatch", () => {
  it("drops a typed name the list can't show when going back to the list", () => {
    expect(manualTogglePatch(draft({ profile: "gone" }), false, READY)).toEqual({ profile: "" })
    expect(manualTogglePatch(draft({ profile: "prod" }), false, READY)).toEqual({})
    expect(manualTogglePatch(draft({ profile: "gone" }), true, READY)).toEqual({})
  })
})
