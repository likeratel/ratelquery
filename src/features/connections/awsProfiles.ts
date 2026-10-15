import type { AwsProfile } from "../../lib/connections"
import { DEFAULT_REGION, type DynamoDraft } from "./form"

/** The draft fields a profile choice reads and fills; DynamoDB and Athena drafts both have them. */
export type ProfileDraft = Pick<DynamoDraft, "name" | "region" | "profile">

/** Result of loading the AWS profiles when the connection dialog opens. */
export type AwsProfilesState =
  | { status: "loading" }
  | { status: "ready"; profiles: readonly AwsProfile[] }
  | { status: "failed" }

/**
 * How the Profile field is shown: a disabled list while loading, the profile list, a text input
 * the user chose (or that an edited connection needs because its profile is not listed), or the
 * text input fallback when no profile could be listed.
 */
export type ProfileInputMode = "loading" | "list" | "manual" | "fallback"

export const NO_PROFILES_HINT = "No profiles found in ~/.aws/config. Type the profile name."
export const PROFILES_FAILED_HINT = "Couldn't read your AWS profiles. Type the profile name."

export function findProfile(state: AwsProfilesState, name: string): AwsProfile | undefined {
  return state.status === "ready" ? state.profiles.find((p) => p.name === name) : undefined
}

/**
 * `manual` is the user's explicit choice from the toggle, or null before they made one; then a
 * profile name that is not in the list (an edited connection) opens in manual mode.
 */
export function profileInputMode(
  state: AwsProfilesState,
  profile: string,
  manual: boolean | null,
): ProfileInputMode {
  if (state.status === "loading") return "loading"
  if (state.status === "failed" || state.profiles.length === 0) return "fallback"
  if (manual !== null) return manual ? "manual" : "list"
  return profile === "" || findProfile(state, profile) ? "list" : "manual"
}

/** Text shown for a profile in the list: its name, then its region and an SSO marker. */
export function profileOptionLabel(profile: AwsProfile): string {
  const details = [profile.region ?? "no region", ...(profile.sso ? ["SSO"] : [])]
  return `${profile.name} (${details.join(", ")})`
}

export interface ProfileChoiceContext {
  /** Whether the dialog is creating a connection, so its region is still the form default. */
  creating: boolean
}

/**
 * Region and name are filled from a chosen profile only where the user has not typed their own
 * value: blank, the new-connection default region, or whatever the previously chosen profile
 * filled in. A saved connection's region counts as the user's own value.
 */
function replaceable(current: string, previousFill: string | undefined, fallback?: string) {
  const value = current.trim()
  return (
    value === "" || value === fallback || (previousFill !== undefined && value === previousFill)
  )
}

/** Draft changes for choosing `name` in the profile list. */
export function profileChoicePatch(
  draft: ProfileDraft,
  name: string,
  state: AwsProfilesState,
  context: ProfileChoiceContext,
): Partial<ProfileDraft> {
  const chosen = findProfile(state, name)
  const previous = findProfile(state, draft.profile)
  const defaultRegion = context.creating ? DEFAULT_REGION : undefined
  const fillRegion =
    chosen?.region != null &&
    replaceable(draft.region, previous?.region ?? undefined, defaultRegion)
  const fillName = chosen !== undefined && replaceable(draft.name, previous?.name)
  return {
    profile: name,
    ...(fillRegion && { region: chosen.region ?? draft.region }),
    ...(fillName && { name: chosen.name }),
  }
}

/**
 * Draft changes for flipping between the list and manual entry. Going back to the list drops a
 * typed name the list can't show, so the field never displays one profile while holding another.
 */
export function manualTogglePatch(
  draft: ProfileDraft,
  toManual: boolean,
  state: AwsProfilesState,
): Partial<ProfileDraft> {
  if (toManual || draft.profile === "" || findProfile(state, draft.profile)) return {}
  return { profile: "" }
}
