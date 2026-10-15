import { useId, useState } from "react"
import { TextField } from "../../components/ui"
import {
  findProfile,
  manualTogglePatch,
  NO_PROFILES_HINT,
  PROFILES_FAILED_HINT,
  profileChoicePatch,
  profileInputMode,
  profileOptionLabel,
  type AwsProfilesState,
} from "./awsProfiles"
import type { DynamoDraft } from "./form"

interface ProfileFieldProps {
  draft: DynamoDraft
  profiles: AwsProfilesState
  error?: string
  /** Whether the dialog creates a connection (its region is then still the form default). */
  creating: boolean
  onChange: (patch: Partial<DynamoDraft>) => void
}

const MANUAL_HINT = "A profile from your AWS config. SSO profiles work too."

function SelectedProfileHint({ draft, profiles }: Pick<ProfileFieldProps, "draft" | "profiles">) {
  const profile = findProfile(profiles, draft.profile)
  if (!profile) return <>Pick the profile whose credentials this connection uses.</>
  return (
    <span className="conn-profile__meta">
      <span>{profile.region ? `Region ${profile.region}` : "No region in this profile"}</span>
      {profile.sso && <span className="conn-profile__badge">SSO</span>}
    </span>
  )
}

export function ProfileField({ draft, profiles, error, creating, onChange }: ProfileFieldProps) {
  const id = useId()
  const [manual, setManual] = useState<boolean | null>(null)
  const mode = profileInputMode(profiles, draft.profile, manual)
  const toggle = (toManual: boolean) => {
    setManual(toManual)
    const patch = manualTogglePatch(draft, toManual, profiles)
    if (Object.keys(patch).length > 0) onChange(patch)
  }

  if (mode === "manual" || mode === "fallback") {
    const fallbackHint = profiles.status === "failed" ? PROFILES_FAILED_HINT : NO_PROFILES_HINT
    return (
      <div className="conn-form__wide conn-profile">
        <TextField
          label="Profile"
          value={draft.profile}
          onValueChange={(profile) => onChange({ profile })}
          error={error}
          placeholder="default"
          hint={mode === "fallback" ? fallbackHint : MANUAL_HINT}
          mono
        />
        {mode === "manual" && (
          <button type="button" className="conn-profile__toggle" onClick={() => toggle(false)}>
            Choose from the list
          </button>
        )}
      </div>
    )
  }

  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const loading = mode === "loading"
  return (
    <div className="conn-form__wide conn-profile">
      <div className="ui-field">
        <label className="ui-field__label" htmlFor={id}>
          Profile
        </label>
        <select
          id={id}
          className="ui-input mono conn-profile__select"
          value={loading ? "" : draft.profile}
          disabled={loading}
          onChange={(event) =>
            onChange(profileChoicePatch(draft, event.target.value, profiles, { creating }))
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hintId}
        >
          <option value="" disabled>
            {loading ? "Loading profiles…" : "Choose a profile"}
          </option>
          {profiles.status === "ready" &&
            profiles.profiles.map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profileOptionLabel(profile)}
              </option>
            ))}
        </select>
        {error ? (
          <p id={errorId} className="ui-field__error" role="alert">
            {error}
          </p>
        ) : (
          <p id={hintId} className="ui-field__hint">
            {loading ? "Reading ~/.aws/config…" : <SelectedProfileHint {...{ draft, profiles }} />}
          </p>
        )}
      </div>
      {!loading && (
        <button type="button" className="conn-profile__toggle" onClick={() => toggle(true)}>
          Enter a name manually
        </button>
      )}
    </div>
  )
}
