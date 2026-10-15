import { useState } from "react"
import { Button, SegmentedControl, showToast, TextField } from "../../components/ui"
import type { FieldErrors, MysqlDraft, SshAuthType } from "./form"
import { canPickKeyFile, pickKeyFile } from "./keyFilePicker"

const AUTH_OPTIONS = [
  { value: "agent", label: "SSH agent" },
  { value: "key", label: "Key file" },
  { value: "password", label: "Password" },
] as const

const AUTH_HINTS: Record<SshAuthType, string> = {
  agent: "Uses the keys loaded in your SSH agent (SSH_AUTH_SOCK).",
  key: "OpenSSH private key on this machine.",
  password: "Signs in to the SSH server with a password.",
}

interface SshFieldsProps {
  draft: MysqlDraft
  errors: FieldErrors
  /** Whether the stored SSH password or passphrase belongs to the auth shown. */
  hasStoredSshSecret: boolean
  storedAuth: SshAuthType | null
  onChange: (patch: Partial<MysqlDraft>) => void
}

function secretHint(kept: boolean, auth: "key" | "password"): string {
  const noun = auth === "key" ? "passphrase" : "password"
  if (kept) return `Saved ${noun} is kept. Type a new one to replace it.`
  if (auth === "key")
    return "Only for encrypted keys. Without a saved one, you're asked when connecting."
  return "Stored like the database password. Leave blank to be asked when connecting."
}

/** "Choose…" next to the key path; hidden outside the Tauri window. */
function ChooseKeyFile({ onPick }: { onPick: (path: string) => void }) {
  const [picking, setPicking] = useState(false)
  if (!canPickKeyFile()) return null
  const choose = async () => {
    setPicking(true)
    try {
      const path = await pickKeyFile()
      if (path) onPick(path)
    } catch (raw) {
      showToast({
        tone: "error",
        message: "Couldn't open the file picker",
        detail: raw instanceof Error ? raw.message : String(raw),
      })
    } finally {
      setPicking(false)
    }
  }
  return (
    <div className="conn-form__file-action">
      {/* Keeps the button level with the input under the field label. */}
      <span className="ui-field__label" aria-hidden>
        &nbsp;
      </span>
      <Button onClick={choose} disabled={picking}>
        Choose…
      </Button>
    </div>
  )
}

/** SSH tunnel settings, shown while "Connect through SSH" is on. */
export function SshFields({
  draft,
  errors,
  hasStoredSshSecret,
  storedAuth,
  onChange,
}: SshFieldsProps) {
  const kept = hasStoredSshSecret && storedAuth === draft.sshAuth
  return (
    <>
      <TextField
        className="conn-form__host"
        label="SSH host"
        value={draft.sshHost}
        onValueChange={(sshHost) => onChange({ sshHost })}
        error={errors.sshHost}
        placeholder="bastion.example.com"
        mono
      />
      <TextField
        className="conn-form__port"
        label="SSH port"
        value={draft.sshPort}
        onValueChange={(sshPort) => onChange({ sshPort })}
        error={errors.sshPort}
        inputMode="numeric"
        mono
      />
      <TextField
        className="conn-form__wide"
        label="SSH user"
        value={draft.sshUser}
        onValueChange={(sshUser) => onChange({ sshUser })}
        error={errors.sshUser}
        placeholder="ec2-user"
        mono
      />
      <div className="conn-form__wide conn-form__auth">
        <span className="ui-field__label">Authentication</span>
        <SegmentedControl<SshAuthType>
          label="SSH authentication"
          value={draft.sshAuth}
          options={AUTH_OPTIONS}
          // A password typed for one method is never reused as the other's secret.
          onChange={(sshAuth) => onChange({ sshAuth, sshSecret: "" })}
        />
        <p className="ui-field__hint">{AUTH_HINTS[draft.sshAuth]}</p>
      </div>
      {draft.sshAuth === "key" && (
        <>
          <div className="conn-form__wide conn-form__file">
            <TextField
              label="Key file"
              value={draft.sshKeyPath}
              onValueChange={(sshKeyPath) => onChange({ sshKeyPath })}
              error={errors.sshKeyPath}
              placeholder="/Users/me/.ssh/id_ed25519"
              hint="Full path to the private key."
              mono
            />
            <ChooseKeyFile onPick={(sshKeyPath) => onChange({ sshKeyPath })} />
          </div>
          <TextField
            className="conn-form__wide"
            label="Key passphrase"
            optional
            type="password"
            value={draft.sshSecret}
            onValueChange={(sshSecret) => onChange({ sshSecret })}
            error={errors.sshSecret}
            placeholder={kept ? "Saved passphrase" : ""}
            hint={secretHint(kept, "key")}
          />
        </>
      )}
      {draft.sshAuth === "password" && (
        <TextField
          className="conn-form__wide"
          label="SSH password"
          type="password"
          value={draft.sshSecret}
          onValueChange={(sshSecret) => onChange({ sshSecret })}
          error={errors.sshSecret}
          placeholder={kept ? "Saved password" : ""}
          hint={secretHint(kept, "password")}
        />
      )}
    </>
  )
}
