import { useId, useState, type FormEvent } from "react"
import { Button, Dialog, TextField } from "../../components/ui"
import { connectionSubtitle } from "./filter"
import { promptCopy, usePasswordPrompt, type PasswordRequest } from "./passwordPrompt"

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
  const copy = promptCopy(request)
  const subtitle = copy.subtitle || connectionSubtitle(request.config)
  const cancel = () => answer(request.id, null)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (secret === "") return
    answer(request.id, { secret, remember })
  }

  return (
    <Dialog
      title={copy.title}
      description={<span className="mono">{subtitle}</span>}
      onClose={cancel}
      footer={
        <>
          {copy.skipLabel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => answer(request.id, { secret: "", remember: false })}
            >
              {copy.skipLabel}
            </Button>
          )}
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
          label={copy.fieldLabel}
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
          {copy.rememberLabel}
        </label>
      </form>
    </Dialog>
  )
}
