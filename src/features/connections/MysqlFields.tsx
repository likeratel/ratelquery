import { TextField } from "../../components/ui"
import { ColorSwatches } from "./ColorSwatches"
import type { FieldErrors, MysqlDraft } from "./form"

interface MysqlFieldsProps {
  draft: MysqlDraft
  errors: FieldErrors
  editing: boolean
  hasStoredSecret: boolean
  onChange: (patch: Partial<MysqlDraft>) => void
}

function passwordHint(editing: boolean, hasStoredSecret: boolean): string {
  if (editing && hasStoredSecret) return "Saved password is kept. Type a new one to replace it."
  if (editing) return "No password is saved for this connection."
  return "Stored in the system keychain, never in the settings file."
}

export function MysqlFields({
  draft,
  errors,
  editing,
  hasStoredSecret,
  onChange,
}: MysqlFieldsProps) {
  return (
    <div className="conn-form__grid">
      <TextField
        className="conn-form__wide"
        label="Name"
        value={draft.name}
        onValueChange={(name) => onChange({ name })}
        error={errors.name}
        placeholder="Local MySQL"
        autoFocus
      />
      <TextField
        className="conn-form__host"
        label="Host"
        value={draft.host}
        onValueChange={(host) => onChange({ host })}
        error={errors.host}
        placeholder="localhost"
        mono
      />
      <TextField
        className="conn-form__port"
        label="Port"
        value={draft.port}
        onValueChange={(port) => onChange({ port })}
        error={errors.port}
        inputMode="numeric"
        mono
      />
      <TextField
        label="User"
        value={draft.user}
        onValueChange={(user) => onChange({ user })}
        error={errors.user}
        placeholder="root"
        mono
      />
      <TextField
        label="Password"
        type="password"
        value={draft.password}
        onValueChange={(password) => onChange({ password })}
        error={errors.password}
        placeholder={editing && hasStoredSecret ? "Saved password" : ""}
        hint={passwordHint(editing, hasStoredSecret)}
      />
      <TextField
        className="conn-form__wide"
        label="Database"
        optional
        value={draft.database}
        onValueChange={(database) => onChange({ database })}
        error={errors.database}
        hint="Default schema to use after connecting."
        mono
      />
      <div className="conn-form__wide">
        <ColorSwatches value={draft.color} onChange={(color) => onChange({ color })} />
      </div>
    </div>
  )
}
