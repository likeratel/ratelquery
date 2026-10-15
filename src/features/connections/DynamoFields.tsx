import { SegmentedControl, TextField } from "../../components/ui"
import { ColorSwatches } from "./ColorSwatches"
import type { DynamoAuthType, DynamoDraft, FieldErrors } from "./form"

interface DynamoFieldsProps {
  draft: DynamoDraft
  errors: FieldErrors
  /** True when a secret access key is already stored and may be left blank. */
  secretOptional: boolean
  onChange: (patch: Partial<DynamoDraft>) => void
}

const AUTH_OPTIONS = [
  { value: "profile", label: "AWS profile" },
  { value: "keys", label: "Access keys" },
] as const

export function DynamoFields({ draft, errors, secretOptional, onChange }: DynamoFieldsProps) {
  return (
    <div className="conn-form__grid">
      <TextField
        className="conn-form__wide"
        label="Name"
        value={draft.name}
        onValueChange={(name) => onChange({ name })}
        error={errors.name}
        placeholder="Production DynamoDB"
        autoFocus
      />
      <TextField
        label="Region"
        value={draft.region}
        onValueChange={(region) => onChange({ region })}
        error={errors.region}
        placeholder="us-east-1"
        mono
      />
      <TextField
        label="Endpoint"
        optional
        value={draft.endpoint}
        onValueChange={(endpoint) => onChange({ endpoint })}
        error={errors.endpoint}
        placeholder="http://localhost:8000"
        hint="Set this for DynamoDB Local."
        mono
      />
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
        <TextField
          className="conn-form__wide"
          label="Profile"
          value={draft.profile}
          onValueChange={(profile) => onChange({ profile })}
          error={errors.profile}
          placeholder="default"
          hint="A profile from your AWS config. SSO profiles work too."
          mono
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
      <div className="conn-form__wide">
        <ColorSwatches value={draft.color} onChange={(color) => onChange({ color })} />
      </div>
    </div>
  )
}
