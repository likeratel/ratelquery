import type { AppError, AppErrorKind } from "../../lib/ipc"

const HINTS: Record<AppErrorKind, string> = {
  query: "DynamoDB rejected the request. Check the expression, placeholders and key values.",
  connection: "DynamoDB couldn't be reached. Check the region, endpoint and network, then retry.",
  credential:
    "AWS credentials are missing, expired or rejected. For SSO profiles run aws sso login, or edit the connection.",
  invalid_input: "Fix the highlighted input and run again.",
  not_found: "The table or connection no longer exists.",
  io: "A local file or system operation failed.",
  unknown: "Something unexpected happened.",
}

/** Guidance under a DynamoDB error, chosen by `kind` only. */
export function dynamoErrorHint(kind: AppErrorKind): string {
  return HINTS[kind]
}

export function DynamoErrorPanel({ error }: { error: AppError }) {
  return (
    <div className="result-error" role="alert">
      <pre className="result-error__message">{error.message}</pre>
      <p className="result-error__hint">{dynamoErrorHint(error.kind)}</p>
    </div>
  )
}
