import { useId } from "react"
import { TextField } from "../../components/ui"
import { workgroupOptions } from "./athenaWorkgroups"
import type { WorkgroupsState } from "./useAthenaWorkgroups"

interface WorkgroupFieldProps {
  value: string
  workgroups: WorkgroupsState
  error?: string
  onChange: (workgroup: string) => void
}

const HINTS: Record<"idle" | "failed", string> = {
  idle: "Fill in the region and authentication to list workgroups.",
  failed: "Couldn't list workgroups. Type the name.",
}

/** Workgroup list from `athena_workgroups`; a text input until (or unless) it loads. */
export function WorkgroupField({ value, workgroups, error, onChange }: WorkgroupFieldProps) {
  const id = useId()
  if (workgroups.status === "idle" || workgroups.status === "failed") {
    return (
      <TextField
        label="Workgroup"
        value={value}
        onValueChange={onChange}
        error={error}
        placeholder="primary"
        hint={HINTS[workgroups.status]}
        mono
      />
    )
  }
  const loading = workgroups.status === "loading"
  const options = loading ? workgroupOptions([], value) : workgroupOptions(workgroups.names, value)
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        Workgroup
      </label>
      <select
        id={id}
        className="ui-input mono conn-profile__select"
        value={value}
        disabled={loading}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hintId}
      >
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errorId} className="ui-field__error" role="alert">
          {error}
        </p>
      ) : (
        <p id={hintId} className="ui-field__hint">
          {loading ? "Loading workgroups…" : "Statements run in this workgroup."}
        </p>
      )}
    </div>
  )
}
