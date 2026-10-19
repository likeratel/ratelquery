import { SegmentedControl, TextField } from "../../components/ui"
import type { MysqlTlsMode } from "../../lib/connections"
import { ColorSwatches } from "./ColorSwatches"
import { useSecretStoreHint } from "./secretStoreHint"
import {
  SSH_NO_VERIFY_IDENTITY,
  verifiesCertificate,
  type FieldErrors,
  type MysqlDraft,
  type SshAuthType,
} from "./form"
import { SshFields } from "./SshFields"

const TLS_OPTIONS = [
  { value: "preferred", label: "Preferred" },
  { value: "required", label: "Required" },
  { value: "verify_ca", label: "Verify CA" },
  { value: "verify_identity", label: "Verify identity" },
] as const

/** Through a tunnel the server is reached as 127.0.0.1, so its host name can't be verified. */
const tlsOptions = (sshEnabled: boolean) =>
  TLS_OPTIONS.map((option) =>
    option.value === "verify_identity" && sshEnabled
      ? {
          ...option,
          label: <span title={SSH_NO_VERIFY_IDENTITY}>{option.label}</span>,
          disabled: true,
        }
      : option,
  )

const TLS_HINTS: Record<MysqlTlsMode, string> = {
  preferred: "Uses TLS when the server offers it, otherwise connects without it.",
  required: "Refuses to connect without TLS, but doesn't check the certificate.",
  verify_ca: "Requires TLS and a certificate signed by a trusted CA.",
  verify_identity: "Requires TLS, a trusted certificate and a matching host name.",
}

interface MysqlFieldsProps {
  draft: MysqlDraft
  errors: FieldErrors
  editing: boolean
  hasStoredSecret: boolean
  /** Whether an SSH password or key passphrase is stored for the edited connection. */
  hasStoredSshSecret: boolean
  /** SSH auth of the connection as saved, which the stored SSH secret belongs to. */
  storedSshAuth: SshAuthType | null
  onChange: (patch: Partial<MysqlDraft>) => void
}

function passwordHint(editing: boolean, hasStoredSecret: boolean, storeHint: string): string {
  if (editing && hasStoredSecret) return "Saved password is kept. Type a new one to replace it."
  if (editing) return "No password is saved for this connection."
  return storeHint
}

export function MysqlFields({
  draft,
  errors,
  editing,
  hasStoredSecret,
  hasStoredSshSecret,
  storedSshAuth,
  onChange,
}: MysqlFieldsProps) {
  const storeHint = useSecretStoreHint()
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
        hint={draft.sshEnabled ? "Host as seen from the SSH server" : undefined}
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
        hint={passwordHint(editing, hasStoredSecret, storeHint)}
      />
      <div className="conn-form__wide conn-form__auth">
        <span className="ui-field__label">TLS</span>
        <SegmentedControl<MysqlTlsMode>
          label="TLS"
          value={draft.tls}
          options={tlsOptions(draft.sshEnabled)}
          onChange={(tls) => onChange({ tls })}
        />
        {errors.tls ? (
          <p className="ui-field__error" role="alert">
            {errors.tls}
          </p>
        ) : (
          <p className="ui-field__hint">{TLS_HINTS[draft.tls]}</p>
        )}
        {draft.sshEnabled && !errors.tls && (
          <p className="ui-field__hint">Verify identity: {SSH_NO_VERIFY_IDENTITY}</p>
        )}
      </div>
      {verifiesCertificate(draft.tls) && (
        <TextField
          className="conn-form__wide"
          label="CA certificate"
          optional
          value={draft.caCertPath}
          onValueChange={(caCertPath) => onChange({ caCertPath })}
          error={errors.caCertPath}
          placeholder="/path/to/ca.pem"
          hint="PEM file with the CA that signed the server certificate."
          mono
        />
      )}
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
      <label className="conn-form__wide conn-remember">
        <input
          type="checkbox"
          checked={draft.sshEnabled}
          // Naming `tls` too clears its "not through a tunnel" error when SSH is turned off.
          onChange={(event) => onChange({ sshEnabled: event.target.checked, tls: draft.tls })}
        />
        Connect through SSH
      </label>
      {draft.sshEnabled && (
        <SshFields
          draft={draft}
          errors={errors}
          hasStoredSshSecret={hasStoredSshSecret}
          storedAuth={storedSshAuth}
          onChange={onChange}
        />
      )}
      <div className="conn-form__wide">
        <ColorSwatches value={draft.color} onChange={(color) => onChange({ color })} />
      </div>
    </div>
  )
}
