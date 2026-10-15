import { useId, useState, type FormEvent } from "react"
import { Button, Dialog, TextField } from "../../components/ui"
import type { ConnectionConfig } from "../../lib/connections"
import { connectionSubtitle } from "./filter"
import { usePasswordPrompt, type PasswordRequest } from "./passwordPrompt"

const promptSubtitle = (config: ConnectionConfig) =>
  config.kind === "mysql"
    ? `${config.user}@${config.host}:${config.port}`
    : connectionSubtitle(config)

/** Mounts the password prompt while a connect is waiting for one. */
export function PasswordPromptDialog() {
  const request = usePasswordPrompt((s) => s.queue[0])
  if (!request) return null
  // Keyed by request so each prompt starts empty.
  return <PasswordPrompt key={request.id} request={request} />
}

function PasswordPrompt({ request }: { request: PasswordRequest }) {
  const answer = usePasswordPrompt((s) => s.answer)
  const [secret, setSecret] = useState("")
  const [remember, setRemember] = useState(true)
  const formId = useId()
  const { config } = request
  const cancel = () => answer(request.id, null)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (secret === "") return
    answer(request.id, { secret, remember })
  }

  return (
    <Dialog
      title={`Password for ${config.name}`}
      description={<span className="mono">{promptSubtitle(config)}</span>}
      onClose={cancel}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => answer(request.id, { secret: "", remember: false })}
          >
            Connect without a password
          </Button>
          <span className="conn-form__spacer" />
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={secret === ""}>
            Connect
          </Button>
        </>
      }
    >
      <form id={formId} className="conn-form" onSubmit={onSubmit} noValidate>
        <TextField
          label="Password"
          type="password"
          value={secret}
          onValueChange={setSecret}
          autoFocus
        />
        <label className="conn-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          Remember password
        </label>
      </form>
    </Dialog>
  )
}
