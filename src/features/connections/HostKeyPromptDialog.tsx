import { ShieldAlert } from "lucide-react"
import { Button, Dialog } from "../../components/ui"
import { canTrustHostKey } from "../../lib/ssh"
import { useHostKeyPrompt, type HostKeyRequest } from "./hostKeyPrompt"

/** Mounts the SSH host key prompt while a connect or test is waiting for a decision. */
export function HostKeyPromptDialog() {
  const request = useHostKeyPrompt((s) => s.queue[0])
  if (!request) return null
  return <HostKeyPrompt key={request.id} request={request} />
}

const CHANGED_WARNING =
  "The server presented a different host key than the one on file. Someone may be intercepting the connection. If the key was replaced on purpose, remove the old entry from known_hosts by hand and connect again."

const UNKNOWN_NOTE =
  "This SSH server isn't in known_hosts yet. Compare the fingerprint with one from the server's administrator before trusting it."

function HostKeyPrompt({ request }: { request: HostKeyRequest }) {
  const answer = useHostKeyPrompt((s) => s.answer)
  const { target, details, message } = request
  const trustable = canTrustHostKey(details)
  const changed = details?.changed ?? false
  const cancel = () => answer(request.id, false)

  return (
    <Dialog
      title={changed ? "SSH host key changed" : "Unknown SSH host key"}
      description={
        <span className="mono">
          {target.host}:{target.port}
        </span>
      }
      onClose={cancel}
      footer={
        <>
          <span className="conn-form__spacer" />
          <Button variant={trustable ? "ghost" : "primary"} onClick={cancel}>
            {trustable ? "Cancel" : "Close"}
          </Button>
          {trustable && (
            <Button variant="primary" onClick={() => answer(request.id, true)}>
              Trust and connect
            </Button>
          )}
        </>
      }
    >
      <div className="conn-form">
        {details && (
          <dl className="conn-hostkey">
            <dt>Host</dt>
            <dd className="mono">
              {target.host}:{target.port}
            </dd>
            <dt>Key type</dt>
            <dd className="mono">{details.keyType}</dd>
            <dt>Fingerprint</dt>
            <dd className="mono conn-hostkey__fingerprint">{details.fingerprint}</dd>
          </dl>
        )}
        {changed ? (
          <div className="conn-test" data-status="fail" role="alert">
            <ShieldAlert size={14} aria-hidden />
            <span className="conn-test__text">{CHANGED_WARNING}</span>
          </div>
        ) : (
          <p className="ui-field__hint">{trustable ? UNKNOWN_NOTE : message}</p>
        )}
      </div>
    </Dialog>
  )
}
