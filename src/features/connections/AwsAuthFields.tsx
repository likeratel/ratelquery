import { SegmentedControl, TextField } from "../../components/ui"
import type { AwsProfilesState, ProfileDraft } from "./awsProfiles"
import type { DynamoAuthType, FieldErrors } from "./form"
import { ProfileField } from "./ProfileField"

/** Draft fields of AWS authentication, shared by DynamoDB and Athena. */
export interface AwsAuthDraft extends ProfileDraft {
  authType: DynamoAuthType
  accessKeyId: string
  secretAccessKey: string
}

interface AwsAuthFieldsProps {
  draft: AwsAuthDraft
  errors: FieldErrors
  /** True when a secret access key is already stored and may be left blank. */
  secretOptional: boolean
  /** AWS profiles offered for the "AWS profile" authentication. */
  profiles: AwsProfilesState
  /** Whether the dialog creates a connection rather than editing one. */
  creating: boolean
  onChange: (patch: Partial<AwsAuthDraft>) => void
  /** Called when the secret access key field loses focus (the typed secret is complete). */
  onSecretBlur?: () => void
}

const AUTH_OPTIONS = [
  { value: "profile", label: "AWS profile" },
  { value: "keys", label: "Access keys" },
] as const

/** Authentication switch plus the profile picker or the access key fields. */
export function AwsAuthFields({
  draft,
  errors,
  secretOptional,
  profiles,
  creating,
  onChange,
  onSecretBlur,
}: AwsAuthFieldsProps) {
  return (
    <>
      <div className="conn-form__wide conn-form__auth">
        <span className="ui-field__label">Authentication</span>
        <SegmentedControl<DynamoAuthType>
          label="Authentication"
          value={draft.authType}
          options={AUTH_OPTIONS}
          onChange={(authType) => onChange({ authType })}
        />
      </div>
      {draft.authType === "profile" ? (
        <ProfileField
          draft={draft}
          profiles={profiles}
          error={errors.profile}
          creating={creating}
          onChange={onChange}
        />
      ) : (
        <>
          <TextField
            label="Access key ID"
            value={draft.accessKeyId}
            onValueChange={(accessKeyId) => onChange({ accessKeyId })}
            error={errors.accessKeyId}
            mono
          />
          <TextField
            label="Secret access key"
            type="password"
            value={draft.secretAccessKey}
            onValueChange={(secretAccessKey) => onChange({ secretAccessKey })}
            onBlur={onSecretBlur}
            error={errors.secretAccessKey}
            placeholder={secretOptional ? "Saved secret" : ""}
            hint={
              secretOptional
                ? "Saved secret is kept. Type a new one to replace it."
                : "Stored in the system keychain."
            }
          />
        </>
      )}
    </>
  )
}
