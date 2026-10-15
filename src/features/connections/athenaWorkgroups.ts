import type { AthenaConnectionConfig, AwsAuth } from "../../lib/connections"
import type { AthenaDraft, FormContext } from "./form"

const REGION = /^[a-z0-9-]+$/

/**
 * What `athena_workgroups` is called with, plus a key that changes when the answer could. The
 * key never holds the secret itself, only its `secretFingerprint`.
 */
export interface WorkgroupRequest {
  config: AthenaConnectionConfig
  secret: string | null
  key: string
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Tells two typed secrets apart without keeping either: the length and a 32-bit FNV-1a hash.
 * Only a change detector for React state and request keys, not a security hash.
 */
export function secretFingerprint(secret: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < secret.length; i += 1) {
    hash = Math.imul(hash ^ secret.charCodeAt(i), FNV_PRIME) >>> 0
  }
  return `${secret.length}:${hash.toString(16)}`
}

/**
 * The workgroup listing for the draft, or null until region and authentication are filled in.
 * Access keys need a stored secret that the backend may still reuse (same region and access key
 * ID as the saved connection), or a typed one the user has finished: `committedSecret` is the
 * `secretFingerprint` taken when the secret field lost focus, so a half-typed secret is never
 * sent to AWS.
 */
export function workgroupRequest(
  draft: AthenaDraft,
  context: FormContext,
  committedSecret: string | null = null,
): WorkgroupRequest | null {
  const region = draft.region.trim()
  if (!REGION.test(region)) return null
  const original = context.original?.kind === "athena" ? context.original : undefined
  const auth = draftAuth(draft)
  if (!auth) return null
  let secret: string | null = null
  let fingerprint: string | null = null
  if (auth.type === "keys") {
    const typed = draft.secretAccessKey.trim()
    const reusable =
      context.hasStoredSecret &&
      original?.auth.type === "keys" &&
      original.auth.accessKeyId === auth.accessKeyId &&
      original.region === region
    if (typed === "" && !reusable) return null
    if (typed !== "") {
      fingerprint = secretFingerprint(typed)
      if (fingerprint !== committedSecret) return null
      secret = typed
    }
  }
  const config: AthenaConnectionConfig = {
    kind: "athena",
    id: original?.id ?? "",
    // The listing doesn't use the name, but the backend validates it as part of the config.
    name: draft.name.trim() || "Athena",
    region,
    auth,
  }
  return { config, secret, key: JSON.stringify([config.id, region, auth, fingerprint]) }
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
