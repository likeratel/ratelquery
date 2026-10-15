import { errorHint } from "../../lib/errorHints"
import type { AppError } from "../../lib/ipc"

export function ErrorPanel({ error }: { error: AppError }) {
  return (
    <div className="result-error" role="alert">
      <pre className="result-error__message">{error.message}</pre>
      <p className="result-error__hint">{errorHint(error.kind)}</p>
    </div>
  )
}
