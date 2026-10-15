import type { AthenaConnectionConfig, AwsAuth } from "../../lib/connections"
import type { AthenaDraft, FormContext } from "./form"

const REGION = /^[a-z0-9-]+$/

/** What `athena_workgroups` is called with, plus a key that changes when the answer could. */
export interface WorkgroupRequest {
  config: AthenaConnectionConfig
  secret: string | null
  key: string
}

/**
 * The workgroup listing for the draft, or null until region and authentication are filled in.
 * Access keys need a typed secret, or a stored one that the backend may still reuse (same
 * region and access key ID as the saved connection).
 */
export function workgroupRequest(
  draft: AthenaDraft,
  context: FormContext,
): WorkgroupRequest | null {
  const region = draft.region.trim()
  if (!REGION.test(region)) return null
  const original = context.original?.kind === "athena" ? context.original : undefined
  const auth = draftAuth(draft)
  if (!auth) return null
  let secret: string | null = null
  if (auth.type === "keys") {
    const typed = draft.secretAccessKey.trim()
    const reusable =
      context.hasStoredSecret &&
      original?.auth.type === "keys" &&
      original.auth.accessKeyId === auth.accessKeyId &&
      original.region === region
    if (typed === "" && !reusable) return null
    secret = typed === "" ? null : typed
  }
  const config: AthenaConnectionConfig = {
    kind: "athena",
    id: original?.id ?? "",
    // The listing doesn't use the name, but the backend validates it as part of the config.
    name: draft.name.trim() || "Athena",
    region,
    auth,
  }
  return { config, secret, key: JSON.stringify([config.id, region, auth, secret]) }
}

function draftAuth(draft: AthenaDraft): AwsAuth | null {
  if (draft.authType === "profile") {
    const profile = draft.profile.trim()
    return profile === "" ? null : { type: "profile", profile }
  }
  const accessKeyId = draft.accessKeyId.trim()
  return accessKeyId === "" ? null : { type: "keys", accessKeyId }
}

/** The listed workgroups, with the draft's current one first when the list lacks it. */
export function workgroupOptions(names: readonly string[], current: string): string[] {
  const value = current.trim()
  return value === "" || names.includes(value) ? [...names] : [value, ...names]
}
