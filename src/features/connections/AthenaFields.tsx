import { useState } from "react"
import { TextField } from "../../components/ui"
import type { AwsProfilesState } from "./awsProfiles"
import { AwsAuthFields } from "./AwsAuthFields"
import { ColorSwatches } from "./ColorSwatches"
import type { AthenaDraft, FieldErrors } from "./form"
import type { WorkgroupsState } from "./useAthenaWorkgroups"
import { WorkgroupField } from "./WorkgroupField"

interface AthenaFieldsProps {
  draft: AthenaDraft
  errors: FieldErrors
  /** True when a secret access key is already stored and may be left blank. */
  secretOptional: boolean
  profiles: AwsProfilesState
  workgroups: WorkgroupsState
  /** Whether the dialog creates a connection rather than editing one. */
  creating: boolean
  onChange: (patch: Partial<AthenaDraft>) => void
}

const hasAdvancedError = (errors: FieldErrors) => Boolean(errors.outputLocation || errors.database)

export function AthenaFields({
  draft,
  errors,
  secretOptional,
  profiles,
  workgroups,
  creating,
  onChange,
}: AthenaFieldsProps) {
  // Starts open when an advanced field is set; an error there always shows it.
  const [advanced, setAdvanced] = useState(
    () => draft.outputLocation.trim() !== "" || draft.database.trim() !== "",
  )
  return (
    <div className="conn-form__grid">
      <TextField
        className="conn-form__wide"
        label="Name"
        value={draft.name}
        onValueChange={(name) => onChange({ name })}
        error={errors.name}
        placeholder="Analytics Athena"
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
      <WorkgroupField
        value={draft.workgroup}
        workgroups={workgroups}
        error={errors.workgroup}
        onChange={(workgroup) => onChange({ workgroup })}
      />
      <AwsAuthFields
        draft={draft}
        errors={errors}
        secretOptional={secretOptional}
        profiles={profiles}
        creating={creating}
        onChange={onChange}
      />
      <details
        className="conn-form__wide conn-advanced"
        open={advanced || hasAdvancedError(errors)}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary className="conn-advanced__summary">Advanced</summary>
        <div className="conn-form__grid conn-advanced__body">
          <TextField
            className="conn-form__wide"
            label="Output location"
            optional
            value={draft.outputLocation}
            onValueChange={(outputLocation) => onChange({ outputLocation })}
            error={errors.outputLocation}
            placeholder="s3://my-bucket/athena/"
            hint="Where Athena writes results. Blank uses the workgroup's, else the default bucket."
            mono
          />
          <TextField
            className="conn-form__wide"
            label="Database"
            optional
            value={draft.database}
            onValueChange={(database) => onChange({ database })}
            error={errors.database}
            hint="Default database of new query tabs."
            mono
          />
        </div>
      </details>
      <div className="conn-form__wide">
        <ColorSwatches value={draft.color} onChange={(color) => onChange({ color })} />
      </div>
    </div>
  )
}
