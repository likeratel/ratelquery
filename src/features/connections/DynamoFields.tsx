import { TextField } from "../../components/ui"
import type { AwsProfilesState } from "./awsProfiles"
import { AwsAuthFields } from "./AwsAuthFields"
import { ColorSwatches } from "./ColorSwatches"
import { insecureEndpointWarning, type DynamoDraft, type FieldErrors } from "./form"

interface DynamoFieldsProps {
  draft: DynamoDraft
  errors: FieldErrors
  /** True when a secret access key is already stored and may be left blank. */
  secretOptional: boolean
  /** AWS profiles offered for the "AWS profile" authentication. */
  profiles: AwsProfilesState
  /** Whether the dialog creates a connection rather than editing one. */
  creating: boolean
  onChange: (patch: Partial<DynamoDraft>) => void
}

export function DynamoFields({
  draft,
  errors,
  secretOptional,
  profiles,
  creating,
  onChange,
}: DynamoFieldsProps) {
  const endpointWarning = insecureEndpointWarning(draft.endpoint)
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
        hint={
          endpointWarning ? (
            <span className="conn-form__warning" role="status">
              {endpointWarning}
            </span>
          ) : (
            "Set this for DynamoDB Local."
          )
        }
        mono
      />
      <AwsAuthFields
        draft={draft}
        errors={errors}
        secretOptional={secretOptional}
        profiles={profiles}
        creating={creating}
        onChange={onChange}
      />
      <div className="conn-form__wide">
        <ColorSwatches value={draft.color} onChange={(color) => onChange({ color })} />
      </div>
    </div>
  )
}
